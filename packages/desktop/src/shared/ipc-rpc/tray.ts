import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const TrayStatusSchema = Schema.Literals(["online", "offline", "busy"])

export type TrayStatus = typeof TrayStatusSchema.Type

export const TrayUpdateStatus = Rpc.make("TrayUpdateStatus", {
  payload: {
    status: TrayStatusSchema,
    activeTasks: Schema.optional(Schema.Number),
  },
})

export const TraySetCloseToTray = Rpc.make("TraySetCloseToTray", {
  payload: {
    enabled: Schema.Boolean,
  },
})

export const TrayGetCloseToTray = Rpc.make("TrayGetCloseToTray", {
  success: Schema.Struct({
    enabled: Schema.Boolean,
  }),
})

export const TrayRpcs = RpcGroup.make(
  TrayUpdateStatus,
  TraySetCloseToTray,
  TrayGetCloseToTray,
)
