import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { KnowledgeMap } from "@orchestra/core/knowledge-map"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]))

describe("knowledge map", () => {
  it.live("scores an agent by verified outcomes, per area and per scope", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = "project:prj_map"
      let map = yield* KnowledgeMap.record(kv, scope, { agent: "developer", area: "auth", outcome: "done", firstTry: true })
      expect(map.skills["auth"]).toMatchObject({ score: 15, tasks: 1, firstTry: 1 })
      map = yield* KnowledgeMap.record(kv, scope, { agent: "developer", area: "auth", outcome: "done" })
      expect(map.skills["auth"]).toMatchObject({ score: 25, tasks: 2, firstTry: 1 })
      map = yield* KnowledgeMap.record(kv, scope, { agent: "developer", area: "auth", outcome: "failed" })
      expect(map.skills["auth"]).toMatchObject({ score: 20, tasks: 3, firstTry: 1 })
      // Another area and another scope stay separate.
      map = yield* KnowledgeMap.record(kv, scope, { agent: "developer", area: "billing", outcome: "done" })
      expect(map.skills["billing"]).toMatchObject({ score: 10, tasks: 1 })
      expect(map.skills["auth"]?.score).toBe(20)
      expect(yield* KnowledgeMap.get(kv, "project:other", "developer")).toBeUndefined()
      expect((yield* KnowledgeMap.get(kv, scope, "developer"))?.skills["auth"]?.score).toBe(20)
      expect(yield* KnowledgeMap.get(kv, scope, "nobody")).toBeUndefined()
    }),
  )

  it.live("ranks the strongest agents in an area and never ranks the unknown", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = "society:Shop"
      yield* KnowledgeMap.record(kv, scope, { agent: "slow", area: "auth", outcome: "done" })
      yield* KnowledgeMap.record(kv, scope, { agent: "fast", area: "auth", outcome: "done", firstTry: true })
      yield* KnowledgeMap.record(kv, scope, { agent: "fast", area: "auth", outcome: "done" })
      yield* KnowledgeMap.record(kv, scope, { agent: "other-area", area: "billing", outcome: "done" })
      const best = yield* KnowledgeMap.bestFor(kv, scope, "auth")
      expect(best.map((entry) => entry.agent)).toEqual(["fast", "slow"])
      expect(best[0]?.score.score).toBe(25)
      expect(yield* KnowledgeMap.bestFor(kv, scope, "auth", 1)).toHaveLength(1)
      expect(yield* KnowledgeMap.bestFor(kv, scope, "never-seen")).toEqual([])
      expect((yield* KnowledgeMap.list(kv, scope)).map((entry) => entry.agent).sort()).toEqual(["fast", "other-area", "slow"])
    }),
  )

  // A3-06: `list` used to return a single `scan` page (100 entries), so the
  // strongest agent past the hundredth was invisible to `bestFor`.
  it.live("lists every agent in a scope past the 100-entry scan default", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = "society:Big"
      for (let index = 0; index < 150; index += 1) {
        yield* KnowledgeMap.record(kv, scope, { agent: `agent-${index}`, area: "auth", outcome: "done" })
      }
      // The last agent is the strongest: two first-try DONE outcomes.
      yield* KnowledgeMap.record(kv, scope, { agent: "agent-149", area: "auth", outcome: "done", firstTry: true })
      const agents = yield* KnowledgeMap.list(kv, scope)
      expect(agents).toHaveLength(150)
      const best = yield* KnowledgeMap.bestFor(kv, scope, "auth", 1)
      expect(best).toHaveLength(1)
      expect(best[0]?.agent).toBe("agent-149")
      expect(best[0]?.score.score).toBe(25)
    }),
  )

  // A3-07: two parallel `verify` outcomes for one agent used to race
  // get-then-set and lose one of them. The race only exists across
  // processes — bun:sqlite is synchronous, so one process can never
  // interleave a get and a set — so the two writers here are two real
  // `bun` processes on the same database file.
  test("concurrent records from two processes never lose an outcome", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    // Boot once so the schema exists before both writers open the file.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.void
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    const runner = path.join(import.meta.dirname, "fixture/knowledge-map-race-runner.ts")
    const gate = path.join(tmp.path, "gate")
    const outcomes = Array.from({ length: 20 }, () => "done").join(",")
    const run = (outcomes: string) => {
      const proc = Bun.spawn(["bun", runner, file, "project:race", "racer", outcomes, gate], {
        cwd: path.join(import.meta.dirname, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      return (async () => {
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        return { code, stdout, stderr }
      })()
    }
    const first = run(outcomes)
    const second = run(outcomes)
    // Both writers are spinning on the gate by now (their boots take ~1s);
    // opening it starts them at the same moment.
    await Bun.sleep(2000)
    writeFileSync(gate, "go")
    const [a, b] = await Promise.all([first, second])
    expect(`${a.stderr}\n${a.stdout}`).not.toContain("error")
    expect(`${b.stderr}\n${b.stdout}`).not.toContain("error")
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    const raw = new BunDatabase(file, { readonly: true })
    try {
      const row = raw.query("SELECT value FROM kv WHERE key = 'knowledge-map/project:race/racer'").get() as
        | { value: string }
        | null
      expect(row).not.toBeNull()
      const map = JSON.parse(row!.value) as { skills: { auth: { tasks: number; score: number } } }
      // Forty DONE outcomes, none lost: 40 tasks, 10 points each, capped at 100.
      expect(map.skills.auth).toMatchObject({ tasks: 40, score: 100 })
    } finally {
      raw.close()
    }
  })
})
