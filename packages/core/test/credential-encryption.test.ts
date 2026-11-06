import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Bus } from "@orchestra/core/bus"
import { Credential } from "@orchestra/core/credential"
import { CredentialEncryption } from "@orchestra/core/credential/encryption"
import { CredentialTable } from "@orchestra/core/credential/sql"
import { Database } from "@orchestra/core/database/database"
import { Integration } from "@orchestra/core/integration"
import { Global } from "@orchestra/util/global"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// G2-10: API keys must not lie in plaintext in SQLite. All test secrets below
// are fake values that never belonged to a real provider.
const FAKE_KEY = "fake-test-key-do-not-use-0123456789"
const FAKE_KEY_2 = "fake-test-key-do-not-use-9876543210"

describe("CredentialEncryption", () => {
  test("round-trips a value and keeps the plaintext out of the envelope", () => {
    const key = CredentialEncryption.createKey()
    const envelope = CredentialEncryption.encrypt(key, JSON.stringify({ type: "key", key: FAKE_KEY }))
    expect(CredentialEncryption.decrypt(key, envelope)).toBe(JSON.stringify({ type: "key", key: FAKE_KEY }))
    expect(JSON.stringify(envelope)).not.toContain(FAKE_KEY)
    expect(envelope.enc).toBe("orchestra-credential-v1")
  })

  test("a wrong key fails honestly instead of returning garbage", () => {
    const envelope = CredentialEncryption.encrypt(CredentialEncryption.createKey(), FAKE_KEY)
    expect(() => CredentialEncryption.decrypt(CredentialEncryption.createKey(), envelope)).toThrow(
      CredentialEncryption.DecryptionError,
    )
  })

  test("a tampered envelope fails honestly", () => {
    const key = CredentialEncryption.createKey()
    const envelope = CredentialEncryption.encrypt(key, FAKE_KEY)
    const tampered = { ...envelope, data: `${envelope.data.slice(0, -2)}AA` }
    expect(() => CredentialEncryption.decrypt(key, tampered)).toThrow(CredentialEncryption.DecryptionError)
  })

  test("decodeStored opens envelopes and passes legacy plaintext through", () => {
    const key = CredentialEncryption.createKey()
    const value = Credential.Key.make({ type: "key", key: FAKE_KEY })
    expect(CredentialEncryption.decodeStored(key, CredentialEncryption.encodeStored(key, value))).toEqual(value)
    expect(CredentialEncryption.decodeStored(key, { type: "key", key: FAKE_KEY })).toEqual(value)
  })

  test("re-encryption under a new key locks the old key out", () => {
    const oldKey = CredentialEncryption.createKey()
    const newKey = CredentialEncryption.createKey()
    const envelope = CredentialEncryption.encrypt(oldKey, FAKE_KEY)
    const rotated = CredentialEncryption.reencryptEnvelope(oldKey, newKey, envelope)
    expect(CredentialEncryption.decrypt(newKey, rotated)).toBe(FAKE_KEY)
    expect(() => CredentialEncryption.decrypt(oldKey, rotated)).toThrow(CredentialEncryption.DecryptionError)
  })

  test("creates a 0600 key file and reuses it, and rejects a corrupt one", async () => {
    await using directory = await tmpdir("g2-keys-")
    const keyFile = path.join(directory.path, "credential.key")
    const first = CredentialEncryption.loadOrCreateKey(keyFile)
    expect(first.length).toBe(32)
    expect(CredentialEncryption.loadOrCreateKey(keyFile)).toEqual(first)
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const { writeFileSync } = await import("node:fs")
    writeFileSync(keyFile, Buffer.alloc(5))
    expect(() => CredentialEncryption.loadOrCreateKey(keyFile)).toThrow(CredentialEncryption.KeyFileError)
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Bus.node, Database.node])))

describe("Credential encrypted at rest", () => {
  it.effect("stores ciphertext in the database and returns the original value", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("anymodel")
      const created = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: FAKE_KEY }),
      })
      const raw = yield* database.db.select().from(CredentialTable).all().pipe(Effect.orDie)
      expect(raw).toHaveLength(1)
      expect(CredentialEncryption.isEnvelope(raw[0]?.value)).toBeTrue()
      expect(JSON.stringify(raw[0]?.value)).not.toContain(FAKE_KEY)
      expect(yield* credentials.list(integrationID)).toEqual([created])
      expect((yield* credentials.get(created.id))?.value).toEqual(
        Credential.Key.make({ type: "key", key: FAKE_KEY }),
      )
    }),
  )

  it.effect("update re-seals the new value", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("anymodel")
      const created = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: FAKE_KEY }),
      })
      yield* credentials.update(created.id, { value: Credential.Key.make({ type: "key", key: FAKE_KEY_2 }) })
      const raw = yield* database.db.select().from(CredentialTable).all().pipe(Effect.orDie)
      expect(JSON.stringify(raw[0]?.value)).not.toContain(FAKE_KEY_2)
      expect((yield* credentials.get(created.id))?.value).toEqual(
        Credential.Key.make({ type: "key", key: FAKE_KEY_2 }),
      )
    }),
  )
})

// The two tests below build their own layer graphs so the credential layer
// boots at a chosen moment (after plaintext rows exist) or against a chosen
// key file — the shared harness builds its layer before the test body runs.
// Node dependencies are always built by the graph, never taken from context,
// so the file database is wired in with `.replace()`, not `Effect.provide`.
// Node dependencies are always built by the graph, never taken from context,
// so the file database is wired in with `.replace()`, not `Effect.provide`.
// Only the replacements are shared: the graphs stay inline literals, so the
// layer output type is inferred from the concrete nodes.
const fileReplacements = (dbFile: string, dataDir: string): LayerNode.Replacements => [
  Database.node.replace(Database.configured({ path: dbFile })),
  Global.node.replace(
    Layer.succeed(Global.Service, Global.Service.of(Global.make({ data: dataDir }))),
  ),
]

const runWithDatabase = <A, E>(
  program: Effect.Effect<A, E, Credential.Service | Bus.Service | Database.Service | Global.Service>,
  dbFile: string,
  dataDir: string,
) =>
  Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([Credential.node, Bus.node, Database.node]), {
          replacements: fileReplacements(dbFile, dataDir),
        }),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make({ data: dataDir }))),
      Effect.scoped,
    ),
  )

// Same, but without the credential layer: the test body boots it itself, after
// seeding plaintext rows, so the startup migration has something to seal.
const runWithDatabaseOnly = <A, E>(
  program: Effect.Effect<A, E, Database.Service | Global.Service>,
  dbFile: string,
  dataDir: string,
) =>
  Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([Database.node]), {
          replacements: fileReplacements(dbFile, dataDir),
        }),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make({ data: dataDir }))),
      Effect.scoped,
    ),
  )

const withKeyFile = async <A>(keyFile: string, body: () => Promise<A>): Promise<A> => {
  const previous = process.env.ORCHESTRA_CREDENTIAL_KEY_FILE
  process.env.ORCHESTRA_CREDENTIAL_KEY_FILE = keyFile
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_CREDENTIAL_KEY_FILE
    else process.env.ORCHESTRA_CREDENTIAL_KEY_FILE = previous
  }
}

describe("Credential migration and wrong keys", () => {
  test("migrates plaintext rows to ciphertext without losing them", async () => {
    await using directory = await tmpdir("g2-keys-")
    const dbFile = path.join(directory.path, "test.db")
    const keyFile = path.join(directory.path, "credential.key")
    const integrationID = Integration.ID.make("anymodel")
    const exit = await withKeyFile(keyFile, () =>
      runWithDatabaseOnly(
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* database.db
            .insert(CredentialTable)
            .values({
              id: Credential.ID.create(),
              integration_id: integrationID,
              label: "legacy",
              value: Credential.Key.make({ type: "key", key: FAKE_KEY }),
              active: true,
            })
            .run()
            .pipe(Effect.orDie)
          // The credential layer boots here — after the plaintext row exists — so the migration seals it.
          return yield* Effect.gen(function* () {
            const credentials = yield* Credential.Service
            const listed = yield* credentials.list(integrationID)
            const raw = yield* database.db.select().from(CredentialTable).all().pipe(Effect.orDie)
            return { listed, raw }
          }).pipe(
            Effect.provide(
              LayerNode.compile(LayerNode.group([Credential.node, Bus.node]), {
                replacements: fileReplacements(dbFile, directory.path),
              }),
            ),
          )
        }),
        dbFile,
        directory.path,
      ),
    )
    expect(Exit.isSuccess(exit)).toBeTrue()
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.listed).toHaveLength(1)
    expect(exit.value.listed[0]?.value).toEqual(Credential.Key.make({ type: "key", key: FAKE_KEY }))
    expect(exit.value.raw).toHaveLength(1)
    expect(CredentialEncryption.isEnvelope(exit.value.raw[0]?.value)).toBeTrue()
    expect(JSON.stringify(exit.value.raw[0]?.value)).not.toContain(FAKE_KEY)
  })

  test("a different key file fails startup honestly instead of serving garbage", async () => {
    await using directory = await tmpdir("g2-keys-")
    const dbFile = path.join(directory.path, "test.db")
    const keyA = path.join(directory.path, "key-a")
    const keyB = path.join(directory.path, "key-b")
    const integrationID = Integration.ID.make("anymodel")
    const created = await withKeyFile(keyA, () =>
      runWithDatabase(
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          return yield* credentials.create({
            integrationID,
            value: Credential.Key.make({ type: "key", key: FAKE_KEY }),
          })
        }),
        dbFile,
        directory.path,
      ),
    )
    expect(Exit.isSuccess(created)).toBeTrue()
    const reopened = await withKeyFile(keyB, () =>
      runWithDatabase(
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          return yield* credentials.list(integrationID)
        }),
        dbFile,
        directory.path,
      ),
    )
    expect(Exit.isFailure(reopened)).toBeTrue()
    if (!Exit.isFailure(reopened)) return
    const text = Cause.prettyErrors(reopened.cause).join("\n")
    expect(text).toMatch(/credential|decrypt|key/i)
  })
})
