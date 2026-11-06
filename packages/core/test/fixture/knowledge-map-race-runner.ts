// Fixture runner for the two-process KnowledgeMap race test: records a list
// of outcomes for one agent in a shared database file, then exits.
//   bun test/fixture/knowledge-map-race-runner.ts <dbFile> <scope> <agent> <done,failed,...> [gateFile]
// With a gate file, the runner waits for the file to appear before recording,
// so two runners started together begin writing at the same moment — the
// shape of the race this fixture exists to catch.
import { existsSync } from "node:fs"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { KnowledgeMap } from "@orchestra/core/knowledge-map"
import { tempGlobalLayer } from "./global"

const [dbFile, scope, agent, outcomesArg, gateFile] = process.argv.slice(2)
if (dbFile === undefined || scope === undefined || agent === undefined || outcomesArg === undefined) {
  console.error("usage: knowledge-map-race-runner.ts <dbFile> <scope> <agent> <done,failed,...> [gateFile]")
  process.exit(2)
}
const outcomes = outcomesArg.split(",").filter((outcome) => outcome === "done" || outcome === "failed") as Array<
  "done" | "failed"
>

if (gateFile !== undefined) {
  // Both writers spin here until the test opens the gate; without it, process
  // startup skew alone would usually serialize the two writers.
  const deadline = Date.now() + 30_000
  while (!existsSync(gateFile)) {
    if (Date.now() > deadline) {
      console.error("gate file never appeared")
      process.exit(3)
    }
    await Bun.sleep(5)
  }
}

await Effect.runPromise(
  Effect.gen(function* () {
    const kv = yield* KV.Service
    for (const outcome of outcomes) {
      yield* KnowledgeMap.record(kv, scope, { agent, area: "auth", outcome })
    }
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [
        Global.node.replace(tempGlobalLayer),
        Database.node.replace(Database.configured({ path: dbFile })),
      ]),
    ),
    Effect.scoped,
  ),
)
