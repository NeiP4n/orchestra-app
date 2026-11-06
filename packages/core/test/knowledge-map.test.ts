import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { KnowledgeMap } from "@orchestra/core/knowledge-map"
import { tempGlobalLayer } from "./fixture/global"
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
})
