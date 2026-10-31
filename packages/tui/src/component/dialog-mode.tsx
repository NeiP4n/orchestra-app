import { createMemo } from "solid-js"
import { Mode } from "@orchestra/schema/mode"
import { useLocal } from "../context/local"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogJailbreak } from "./dialog-jailbreak"

// Jailbreak changes what the model is willing to say, not how it works, so it keeps its own section
// instead of sitting among the work modes.
const category = (id: string) =>
  id === "jailbreak" || Mode.jailbreakPromptID(id) !== undefined ? "Jailbreak" : "Work modes"

export const modeOptions = (modes: ReadonlyArray<Mode.Spec>) =>
  modes.map((mode) => ({
    value: String(mode.id),
    title: String(mode.id) === "jailbreak" ? "Jailbreak" : mode.name,
    category: category(String(mode.id)),
    description: [mode.description, mode.readOnly ? "read-only" : ""].filter(Boolean).join(" · "),
  }))

// What the picker shows: one row per work mode plus a single Jailbreak row. Only the display
// collapses — `local.mode.list()` keeps every policy, because an agent resolves its mode by the
// full `jailbreak:<policy id>`, and the row opens the policies one level deeper.
export const modeRows = (modes: ReadonlyArray<Mode.Spec>) =>
  modeOptions(modes.filter((mode) => Mode.jailbreakPromptID(String(mode.id)) === undefined))

// The picker works in two places: the composer (the chat being written) and a session row
// in the roster (a worker the operator wants to retune). A new chat keeps the choice as a
// draft until its session exists.
export function DialogMode(props: { sessionID?: string }) {
  const local = useLocal()
  const dialog = useDialog()

  const current = () => {
    const id = props.sessionID ? local.mode.currentFor(props.sessionID) : local.mode.current()
    // A pinned policy still belongs to the single Jailbreak row.
    return Mode.jailbreakPromptID(id) === undefined ? id : "jailbreak"
  }
  const options = createMemo(() =>
    modeRows(local.mode.list()).map((option) => ({
      ...option,
      onSelect: () => {
        // The Jailbreak row chooses a policy first instead of setting a mode itself.
        if (option.value === "jailbreak") {
          dialog.replace(() => <DialogJailbreak sessionID={props.sessionID} />)
          return
        }
        dialog.clear()
        if (props.sessionID) local.mode.setFor(props.sessionID, option.value)
        else local.mode.set(option.value)
      },
    })),
  )

  return <DialogSelect<string> title="Work mode" current={current()} options={options()} flat tall />
}

DialogMode.show = (dialog: DialogContext, sessionID?: string) =>
  dialog.replace(() => <DialogMode sessionID={sessionID} />)
