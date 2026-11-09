import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database as CoreDatabase } from "@orchestra/core/database/database"
import { Location } from "@orchestra/core/location"
import { Memory } from "@orchestra/core/memory/index"
import { AbsolutePath } from "@orchestra/core/schema"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Journal } from "@orchestra/core/journal"
import { MemoryEngine, getMemoryEngineForProject } from "@orchestra/core/memory/engine"
import {
  applyMemoryMigrations,
  backupMemoryDatabase,
  initMemorySchema,
  openMemoryDatabase,
  resolveDefaultMemoryDbPath,
  CURRENT_MEMORY_SCHEMA_VERSION,
} from "@orchestra/core/memory/db"
import { countSecrets, scrubText, scrubValue, REDACTED } from "@orchestra/core/memory/scrub"
import { location } from "./fixture/location"
import { tmpdir, withTempDir } from "./fixture/tmpdir"

// Б17 slice 1 (foundation gates): durable memory.db (B18 №36–№41, minimum),
// secret scrubber (§7 risk 2), journal scrubbing, project-dir engine path.
// Bus durable-persist default (B18 №14) is already closed in main (G2-7)
// and covered by `bus-durable-default.test.ts` — run, not duplicated here.

const PLANTED = {
  anymodelLabelled: `anymodel_api_key = "am-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3"`,
  anymodelPrefix: "key anymodel-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3 here",
  lixPrefix: "key lix-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3 here",
  lixLabelled: `lix_key: hunter2-lix-secret-value-99`,
  openai: "sk-proj-abcdefghij1234567890ABCDEFGH",
  anthropic: "sk-ant-api03-abcdefghij1234567890-AA",
  bearer: "Authorization: Bearer abcdefghij1234567890ABCDEFGHIJ",
  password: `password: "hunter2-correct-horse-battery"`,
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x\n-----END RSA PRIVATE KEY-----",
  github: "ghp_abcdefghij1234567890ABCDEFGH",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  urlCreds: "https://deploy:s3cret-password-99@example.com/hooks",
}

const PLANTED_FRAGMENTS = [
  "am-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3",
  "anymodel-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3",
  "lix-9f2c41d7e8b3a6f0c5d4e7b8a9c0d1e2f3",
  "hunter2-lix-secret-value-99",
  "sk-proj-abcdefghij1234567890ABCDEFGH",
  "sk-ant-api03-abcdefghij1234567890-AA",
  "abcdefghij1234567890ABCDEFGHIJ",
  "hunter2-correct-horse-battery",
  "MIIEowIBAAKCAQEA7x",
  "ghp_abcdefghij1234567890ABCDEFGH",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "s3cret-password-99",
]

const assertNoSecrets = (text: string) => {
  for (const fragment of PLANTED_FRAGMENTS) expect(text).not.toContain(fragment)
}

describe("secret scrubber", () => {
  test("redacts every planted secret shape and keeps the label", () => {
    for (const planted of Object.values(PLANTED)) {
      const clean = scrubText(planted)
      assertNoSecrets(clean)
      expect(clean).toContain(REDACTED)
      expect(scrubText(clean)).toBe(clean)
      expect(countSecrets(planted)).toBeGreaterThan(0)
    }
    // Labelled values keep their label so the reader still sees WHAT was there.
    expect(scrubText(`api_key = "supersecretvalue123"`)).toBe(`api_key = ${REDACTED}`)
    expect(scrubText(`password: hunter2-correct-horse`)).toBe(`password: ${REDACTED}`)
    expect(scrubText("https://deploy:s3cret-password-99@example.com/hooks")).toBe(
      `https://deploy:${REDACTED}@example.com/hooks`,
    )
  })

  test("leaves benign prose alone", () => {
    expect(scrubText("The secret sauce is great")).toBe("The secret sauce is great")
    expect(scrubText("my password is hunter2")).toBe("my password is hunter2")
    expect(scrubText("token economics and key results")).toBe("token economics and key results")
    expect(scrubText("No secrets here, just architecture notes.")).toBe("No secrets here, just architecture notes.")
    expect(countSecrets("No secrets here, just architecture notes.")).toBe(0)
  })

  test("scrubValue recurses into objects and arrays, keeps other types", () => {
    const cleaned = scrubValue({
      note: PLANTED.openai,
      nested: { list: [PLANTED.password, 42, true, null] },
    }) as { note: string; nested: { list: Array<unknown> } }
    expect(cleaned.note).toBe(REDACTED)
    expect(cleaned.nested.list[0]).toBe(`password: ${REDACTED}`)
    expect(cleaned.nested.list.slice(1)).toEqual([42, true, null])
  })
})

describe("memory.db foundation (B18 №36–№41, minimum)", () => {
  test("resolves under the project dir, not the process working directory", () => {
    // A POSIX-rooted literal like "/tmp/..." is drive-qualified by
    // path.resolve on Windows, so the fixture root is built through the
    // host's own path API instead of a hardcoded POSIX path.
    const projectDir = path.resolve("orchestra-foundation-probe")
    expect(resolveDefaultMemoryDbPath(projectDir)).toBe(
      path.join(projectDir, ".orchestra", "memory.db"),
    )
    expect(resolveDefaultMemoryDbPath()).toBe(path.join(process.cwd(), ".orchestra", "memory.db"))
    expect(resolveDefaultMemoryDbPath(projectDir)).not.toBe(resolveDefaultMemoryDbPath())
  })

  test("opens with synchronous FULL, WAL and a recorded schema version", async () => {
    await using tmp = await tmpdir()
    const engine = MemoryEngine.open({ projectDir: tmp.path })
    try {
      expect(engine.dbPath).toBe(path.join(tmp.path, ".orchestra", "memory.db"))
      expect(fs.existsSync(engine.dbPath as string)).toBe(true)
      const sync = (engine.db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous
      expect(sync).toBe(2)
      const journal = (engine.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode
      expect(journal).toBe("wal")
      const versions = engine.db.query("SELECT version FROM memory_migrations").all() as Array<{ version: number }>
      expect(versions).toEqual([{ version: CURRENT_MEMORY_SCHEMA_VERSION }])
      expect(CURRENT_MEMORY_SCHEMA_VERSION).toBe(1)
    } finally {
      engine.close()
    }
  })

  test("a legacy database without a migrations table keeps its data and gains version 1", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "memory.db")
    const legacy = new Database(file, { create: true })
    initMemorySchema(legacy)
    legacy.run(`INSERT INTO entities (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      "ent_legacy",
      "legacy",
      "concept",
      1,
      1,
    ])
    legacy.close()
    const probe = new Database(file)
    try {
      expect(() => probe.query("SELECT version FROM memory_migrations").all()).toThrow()
    } finally {
      probe.close()
    }

    const reopened = openMemoryDatabase({ path: file })
    try {
      const rows = reopened.query("SELECT id FROM entities WHERE id = ?").all("ent_legacy") as Array<{ id: string }>
      expect(rows).toHaveLength(1)
      expect(applyMemoryMigrations(reopened)).toBe(1)
      const versions = reopened.query("SELECT version FROM memory_migrations").all() as Array<{ version: number }>
      expect(versions).toEqual([{ version: 1 }])
    } finally {
      reopened.close()
    }
  })

  test("backupMemoryDatabase snapshots a live database and verifies the copy", async () => {
    await using tmp = await tmpdir()
    const engine = MemoryEngine.open({ projectDir: tmp.path })
    engine.remember({ text: "Backup probe: the project uses Bun and Effect.", scope: "project" })
    const destination = path.join(tmp.path, "backups", "memory.db")
    try {
      const result = backupMemoryDatabase(engine.dbPath as string, destination)
      expect(result.path).toBe(destination)
      expect(result.sizeBytes).toBeGreaterThan(0)
      const copy = new Database(destination, { readonly: true })
      try {
        const rows = copy.query("SELECT content FROM observations").all() as Array<{ content: string }>
        expect(rows.map((row) => row.content)).toEqual(["Backup probe: the project uses Bun and Effect."])
        const versions = copy.query("SELECT version FROM memory_migrations").all() as Array<{ version: number }>
        expect(versions).toEqual([{ version: 1 }])
      } finally {
        copy.close()
      }
    } finally {
      engine.close()
    }
    expect(() => backupMemoryDatabase(path.join(tmp.path, "nope.db"), path.join(tmp.path, "x.db"))).toThrow(/not found/)
  })

  test("getMemoryEngineForProject caches per project and never shares databases", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const first = getMemoryEngineForProject(tmpA.path)
    const again = getMemoryEngineForProject(tmpA.path)
    const other = getMemoryEngineForProject(tmpB.path)
    // Both handles are closed before the temp folders are removed: on Windows an open SQLite file cannot be deleted,
    // and the folder removal retried for 5 seconds (the test's whole timeout).
    try {
      expect(again).toBe(first)
      expect(other).not.toBe(first)
      expect(other.dbPath).toBe(path.join(tmpB.path, ".orchestra", "memory.db"))
      first.remember({ text: "Project A only fact.", scope: "project" })
      expect(other.search("Project A only fact")).toHaveLength(0)
    } finally {
      first.close()
      other.close()
    }
  })
})

describe("MemoryEngine scrub gate", () => {
  test("remembered secrets reach no table, index or recall output", async () => {
    await using tmp = await tmpdir()
    const engine = MemoryEngine.open({ projectDir: tmp.path })
    try {
      const plantedText = `Deploy notes: ${PLANTED.anymodelLabelled} and token ${PLANTED.openai}, see ${PLANTED.urlCreds}`
      const result = engine.remember({
        text: plantedText,
        entity: {
          name: "deploy",
          summary: `uses ${PLANTED.password}`,
          metadata: { key: PLANTED.github, nested: { token: PLANTED.bearer } },
        },
        scope: "project",
        source: `session ${PLANTED.lixPrefix}`,
      })
      expect(result.observationID).toBeTruthy()

      // Every persisted surface: observations, docs, FTS, terms, entities.
      const dump = [
        ...(engine.db.query("SELECT content FROM observations").all() as Array<{ content: string }>).map(
          (row) => row.content,
        ),
        ...(engine.db.query("SELECT content FROM docs").all() as Array<{ content: string }>).map((row) => row.content),
        ...(engine.db.query("SELECT content FROM fts_obs").all() as Array<{ content: string }>).map(
          (row) => row.content,
        ),
        ...(engine.db.query("SELECT term FROM terms").all() as Array<{ term: string }>).map((row) => row.term),
        ...(
          engine.db.query("SELECT summary, metadata FROM entities").all() as Array<{
            summary: string | null
            metadata: string | null
          }>
        ).flatMap((row) => [row.summary ?? "", row.metadata ?? ""]),
        ...(engine.db.query("SELECT source FROM observations").all() as Array<{ source: string | null }>).map(
          (row) => row.source ?? "",
        ),
      ].join("\n")
      assertNoSecrets(dump)
      expect(dump).toContain(REDACTED)
      assertNoSecrets(engine.recall("Deploy notes"))
    } finally {
      engine.close()
    }
  })

  test("link metadata is scrubbed before the relation is stored", async () => {
    await using tmp = await tmpdir()
    const engine = MemoryEngine.open({ projectDir: tmp.path })
    try {
      engine.link({
        source: "deploy",
        target: "server",
        type: "uses",
        metadata: { credential: PLANTED.jwt },
      })
      const rows = engine.db.query("SELECT metadata FROM relations").all() as Array<{ metadata: string | null }>
      expect(rows).toHaveLength(1)
      assertNoSecrets(rows[0]?.metadata ?? "")
      expect(rows[0]?.metadata).toContain(REDACTED)
    } finally {
      engine.close()
    }
  })
})

function withMemory<A, E>(
  directory: string,
  body: (memory: Memory.Interface, db: CoreDatabase.Interface["db"]) => Effect.Effect<A, E>,
) {
  const data = path.join(directory, "data")
  return Effect.gen(function* () {
    const database = yield* CoreDatabase.Service
    return yield* body(yield* Memory.Service, database.db)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Memory.node, CoreDatabase.node]), [
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(path.join(directory, "repo")) })),
          ),
        ),
        Global.node.replace(Global.layerWith({ ...Global.make(), data })),
        CoreDatabase.node.replace(CoreDatabase.configured({ path: path.join(directory, "memory.sqlite") })),
      ]),
    ),
  )
}

describe("Memory service file scrub gate", () => {
  test("block and archive files on disk hold no planted secrets", async () => {
    await withTempDir((tmp) =>
      withMemory(tmp.path, (memory) =>
        Effect.gen(function* () {
          const repo = path.join(tmp.path, "repo")
          yield* memory.rewrite({
            label: "stack",
            value: `Deploy key: ${PLANTED.anymodelPrefix} and ${PLANTED.privateKey}`,
            description: "Tech stack",
          })
          yield* memory.remember({ text: `Runbook: ${PLANTED.password} then ${PLANTED.bearer}`, scope: "project" })

          const blockFile = path.join(repo, ".orchestra", "memory", "blocks", "stack.md")
          const archiveFile = path.join(repo, ".orchestra", "memory", "archive.jsonl")
          const blockContent = fs.readFileSync(blockFile, "utf8")
          const archiveContent = fs.readFileSync(archiveFile, "utf8")
          assertNoSecrets(blockContent)
          assertNoSecrets(archiveContent)
          expect(blockContent).toContain(REDACTED)
          expect(archiveContent).toContain(REDACTED)

          const blocks = yield* memory.blocks()
          const stack = blocks.find((block) => block.label === "stack")
          assertNoSecrets(stack?.value ?? "")
        }),
      ),
    ).pipe(Effect.runPromise)
  })
})

describe("Journal scrub gate", () => {
  test("recordError stores the scrubbed message and detail", async () => {
    const run = <A, E>(effect: Effect.Effect<A, E, CoreDatabase.Service>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(CoreDatabase.layer({ path: ":memory:" })),
          Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
          Effect.scoped,
        ),
      )
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([
          { id: "f1", type: "run.queued", collection: "runs", key: "run_1", data: { state: "queued", session: "s" } },
        ])
        yield* Journal.recordError({
          source: "session-runner",
          kind: "stream-interrupted",
          message: `Provider call failed with ${PLANTED.openai} in the payload`,
          sessionID: "ses_test",
          detail: { endpoint: PLANTED.urlCreds, attempt: 1 },
        })
        const errors = yield* Journal.readErrors()
        expect(errors).toHaveLength(1)
        assertNoSecrets(errors[0]?.message ?? "")
        assertNoSecrets(JSON.stringify(errors[0]?.detail ?? {}))
        expect(errors[0]?.message).toContain(REDACTED)
        expect(errors[0]?.detail).toEqual({ endpoint: `https://deploy:${REDACTED}@example.com/hooks`, attempt: 1 })
      }),
    )
  })
})
