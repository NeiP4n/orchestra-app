import { Effect } from "effect"
import { ShortcutRpcs } from "../../shared/ipc-rpc"
import { getQuickActionShortcut, registerQuickActionShortcut } from "../native/shortcuts"

export { getQuickActionShortcut }

export const shortcutHandlers = ShortcutRpcs.toLayer(
  Effect.gen(function* () {
    return ShortcutRpcs.of({
      ShortcutsRegisterQuickAction: ({ shortcut }) =>
        Effect.sync(() => {
          registerQuickActionShortcut(shortcut)
        }),
    })
  }),
)
