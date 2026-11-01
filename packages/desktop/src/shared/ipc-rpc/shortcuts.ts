import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const ShortcutsRegisterQuickAction = Rpc.make("ShortcutsRegisterQuickAction", {
  payload: {
    shortcut: Schema.String,
  },
})

export const ShortcutRpcs = RpcGroup.make(ShortcutsRegisterQuickAction)
