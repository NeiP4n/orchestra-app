import { createMemo } from "solid-js"
import { Mode } from "@orchestra/schema/mode"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogMode } from "./dialog-mode"

// The bundled policies behind the single Jailbreak row of the mode picker. Automatic keeps the bare
// `jailbreak` mode, where the policy is chosen from the model the session runs on; every other row
// pins that policy as `jailbreak:<policy id>`.
export const jailbreakOptions = () => [
  {
    value: "jailbreak",
    title: "Automatic (fits the model)",
    description: "The policy is picked from the model this session runs on.",
  },
  ...Mode.jailbreakModes().map((mode) => ({
    value: String(mode.id),
    title: mode.name,
  })),
]

export function DialogJailbreak(props: { sessionID?: string }) {
  const local = useLocal()
  const dialog = useDialog()

  const current = () => (props.sessionID ? local.mode.currentFor(props.sessionID) : local.mode.current())
  const options = createMemo(() =>
    jailbreakOptions().map((option) => ({
      ...option,
      onSelect: () => {
        dialog.clear()
        if (props.sessionID) local.mode.setFor(props.sessionID, option.value)
        else local.mode.set(option.value)
      },
    })),
  )

  return (
    <DialogSelect<string>
      title="Jailbreak"
      current={current()}
      options={options()}
      flat
      tall
      // The list is one level deeper than the mode picker, so Escape returns to it instead of closing.
      onCancel={() => dialog.replace(() => <DialogMode sessionID={props.sessionID} />)}
    />
  )
}
