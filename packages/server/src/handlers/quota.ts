import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { calculateTokenQuota } from "@orchestra/protocol/quota"
import { Effect } from "effect"

export const QuotaHandler = HttpApiBuilder.group(Api, "quota", (handlers) =>
  handlers.handle("quota.check", ({ payload }) =>
    Effect.succeed(calculateTokenQuota(payload)),
  ),
)
