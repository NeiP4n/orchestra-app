export * as RecoveryModels from "./models.js"

import type { Recovery } from "@orchestra/schema/recovery"
import type { Model } from "../model.js"

/**
 * The recovery mini-chat offers every enabled model, in the order
 * Model.available() gives (newest release first). No provider is hardcoded
 * here: there is no liveness signal on Model.Info (available() only means
 * enabled), so a name list would rot the moment a provider dies or recovers
 * — Anymodel was down with HTTP 502 one day and fine the next. A dead model
 * is handled where it belongs: Recovery.chat catches the failed call and
 * tells the user to try another model from this same list.
 */
export function listRecoveryModels(models: readonly Model.Info[]): readonly Recovery.RecoveryModel[] {
  return models.map((info) => ({
    providerID: info.providerID,
    id: info.id,
    name: info.name,
  }))
}
