export * as CapabilityRecommendation from "./recommend.js"
import { Effect } from "effect"
import { ToolRecommendation } from "../tool-recommendation.js"
import type { KV } from "../kv.js"
import { OutcomeLedger } from "./outcome-ledger.js"
import type { Snapshot } from "./registry.js"

/** One policy across native/MCP/CLI adapters. No provider selector, execution or configuration effect.
 * This method persists a deduplicated decision ordinal; exploration remains opt-in and read-only. */
export function recommend(
  kv: Pick<KV.Interface, "get" | "atomicUpdate">,
  input: {
    scope: OutcomeLedger.Scope
    decisionID: string
    snapshot: Snapshot
    now: number
    readOnlyIDs: ReadonlySet<string>
    currentToolID?: string
    exploration?: boolean
  },
) {
  return Effect.gen(function* () {
    if (
      !Number.isSafeInteger(input.snapshot.at) ||
      input.snapshot.at < 0 ||
      input.snapshot.at > input.now ||
      input.now - input.snapshot.at > 60_000
    )
      throw Error("Capability snapshot is stale; revalidate before recommendation.")
    const ledger = OutcomeLedger.make(kv)
    const evidence = yield* ledger.metrics(input.scope, input.now)
    const decisionOrdinal = yield* ledger.nextDecision(input.scope, input.decisionID)
    const adapters = input.snapshot.entries.filter((row) => row.group === input.scope.capability)
    const result = ToolRecommendation.recommend({
      ...input.scope,
      now: input.now,
      decisionOrdinal,
      currentToolID: input.currentToolID,
      exploration: input.exploration,
      allowedToolIDs: new Set(adapters.filter((row) => row.permission === "allowed").map((row) => row.id)),
      candidates: adapters.map((row) => ({
        id: row.id,
        available: row.state === "ready",
        paid: row.cost !== "local-only",
        needsKey: row.credential !== "ready",
        readOnly: input.readOnlyIDs.has(row.id),
      })),
      metrics: evidence.metrics.filter((row): row is ToolRecommendation.Metrics => row.totalOutputTokens !== null),
    })
    return {
      ...result,
      decisionOrdinal,
      unverifiedAttempts: evidence.unverified,
      unmeasuredToolIDs: evidence.metrics.filter((row) => row.totalOutputTokens === null).map((row) => row.toolID),
      unknownCostToolIDs: adapters.filter((row) => row.cost === "unknown").map((row) => row.id),
    }
  })
}
