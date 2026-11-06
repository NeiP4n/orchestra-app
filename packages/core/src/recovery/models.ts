export * as RecoveryModels from "./models.js"

import type { Recovery } from "@orchestra/schema/recovery"
import type { Model } from "../model.js"

/**
 * Providers the recovery mini-chat offers. Anymodel is down (HTTP 502 on
 * chat), so it is never offered — a dead model in the list would waste the
 * user's one shot at fixing a broken Orchestra.
 */
const WORKING_PROVIDERS: ReadonlyArray<string> = ["klinch", "lix"]

/** Only the working providers, klinch first (Claude is the strongest repair model). */
export function listRecoveryModels(models: readonly Model.Info[]): readonly Recovery.RecoveryModel[] {
  return models
    .filter((info) => WORKING_PROVIDERS.includes(info.providerID))
    .sort((a, b) => WORKING_PROVIDERS.indexOf(a.providerID) - WORKING_PROVIDERS.indexOf(b.providerID))
    .map((info) => ({
      providerID: info.providerID,
      id: info.id,
      name: info.name,
    }))
}
