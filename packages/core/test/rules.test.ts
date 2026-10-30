import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Rules } from "@orchestra/core/rules"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]))

describe("rulebook", () => {
  it.live("keeps rules per scope, refuses duplicates and empty text, and removes by id", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.projectScope("prj_a")
      const first = yield* Rules.add(kv, scope, { text: "  Never edit   generated files. ", by: "team-developer" })
      expect(first.rule?.text).toBe("Never edit generated files.")
      expect(yield* Rules.add(kv, scope, { text: "never edit generated files.", by: "x" })).toEqual({ error: "That rule already exists." })
      expect(yield* Rules.add(kv, scope, { text: "   ", by: "x" })).toEqual({ error: "A rule needs text." })
      expect((yield* Rules.list(kv, Rules.projectScope("prj_b"))).length).toBe(0)

      const rule = first.rule
      if (!rule) throw new Error("expected a rule")
      expect(yield* Rules.remove(kv, scope, rule.id)).toBe(true)
      expect(yield* Rules.remove(kv, scope, rule.id)).toBe(false)
      expect(yield* Rules.list(kv, scope)).toEqual([])
    }),
  )

  it.live("caps a scope and truncates long rules", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.societyScope("Games")
      for (let index = 0; index < Rules.MAX_PER_SCOPE; index++)
        expect((yield* Rules.add(kv, scope, { text: `rule ${index}`, by: "operator" })).rule).toBeDefined()
      expect(yield* Rules.add(kv, scope, { text: "one too many", by: "operator" })).toMatchObject({ error: expect.stringContaining("already has") })
      const long = yield* Rules.add(kv, Rules.GLOBAL, { text: "x".repeat(1000), by: "operator" })
      expect(long.rule?.text.length).toBe(Rules.MAX_TEXT)
    }),
  )

  it.live("renders one block with the Society's rules first, then the project's, then the global ones", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.societyScope("Shop"), { text: "Every project writes its API contract first.", by: "operator" })
      yield* Rules.add(kv, Rules.projectScope("prj_shop"), { text: "Use bun, not npm.", by: "team-developer" })
      const block = yield* Rules.block(kv, { project: "prj_shop", societies: ["Shop"] })
      const lines = block.split("\n")
      const society = lines.findIndex((line) => line.includes("[Society]"))
      const project = lines.findIndex((line) => line.includes("[Project]"))
      expect(society).toBeGreaterThan(0)
      expect(project).toBeGreaterThan(society)
      // A session outside the Society and the project sees none of their rules.
      expect(yield* Rules.block(kv, { societies: [] })).not.toContain("[Society]")
    }),
  )

  it.live("says nothing when no rule applies", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      expect(yield* Rules.block(kv, { project: "prj_none", societies: ["Nothing"] })).not.toContain("[Project]")
    }),
  )
})
