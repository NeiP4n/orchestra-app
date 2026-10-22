import { createMemo, createSignal } from "solid-js"
import { Schema } from "effect"
import { useConfig } from "../config"
import { TuiKeybind } from "../config/keybind"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"

type Name = keyof typeof TuiKeybind.Definitions

// Bindings that only act inside one view (a dialog, the diff viewer, the text input) may reuse
// keys of the global ones; only clashes between global bindings are real conflicts.
const SCOPED = ["input.", "dialog.", "diff.", "composer.", "prompt.autocomplete.", "which-key.", "queued_prompt.", "stash.", "model.dialog.", "plugins.toggle", "permission."]
const GROUPS: readonly [string, string][] = [
  ["session.tab.", "Tabs"],
  ["session.", "Session"],
  ["prompt.", "Prompt"],
  ["input.", "Text input"],
  ["model.", "Model"],
  ["mode.", "Model"],
  ["variant.", "Model"],
  ["agent.", "Agent"],
  ["diff.", "Diff viewer"],
  ["dialog.", "Dialogs"],
  ["composer.", "Composer"],
  ["terminal.", "Terminal"],
  ["pane.", "Terminal"],
  ["theme.", "Appearance"],
  ["which-key.", "Which key"],
]

export function DialogKeybinds() {
  const config = useConfig()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const t = useT()
  const [selected, setSelected] = createSignal<Name>()
  const names = Object.keys(TuiKeybind.Definitions).filter(
    (name) => !TuiKeybind.Definitions[name as Name].description.startsWith("Deprecated"),
  ) as Name[]

  const current = (name: Name) =>
    config.data.keybinds
      .get(name)
      .map((binding) => (typeof binding.key === "string" ? binding.key : binding.key.name))
      .join(",") || "none"
  const custom = (name: Name) => current(name) !== String(TuiKeybind.defaultValue(name) || "none")
  const global = (name: Name) => !SCOPED.some((prefix) => name.startsWith(prefix))
  // Which global commands share a key: a key pressed anywhere can only run one of them.
  const clashes = createMemo(() => {
    const owners = new Map<string, Name[]>()
    names.filter(global).forEach((name) =>
      current(name)
        .split(",")
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key && key !== "none")
        .forEach((key) => owners.set(key, [...(owners.get(key) ?? []), name])),
    )
    return new Map([...owners].filter(([, list]) => list.length > 1))
  })
  const conflicts = (name: Name) =>
    global(name)
      ? current(name)
          .split(",")
          .flatMap((key) => (clashes().get(key.trim().toLowerCase()) ?? []).filter((other) => other !== name))
      : []

  const options = createMemo(() =>
    names.map((name) => ({
      title: t(TuiKeybind.Definitions[name].description),
      category: t(GROUPS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "General"),
      searchText: [name, TuiKeybind.Definitions[name].description, current(name)].join(" "),
      footer: `${conflicts(name).length ? "⚠ " : custom(name) ? "● " : ""}${current(name)}`,
      footerColor: conflicts(name).length
        ? theme.text.feedback.warning.base
        : custom(name)
          ? theme.text.formfield.selected
          : undefined,
      value: name,
    })),
  )

  const save = (name: Name, value: string | undefined) =>
    config
      .update((draft) => {
        const keybinds = { ...(draft.keybinds ?? {}) } as Record<string, unknown>
        if (value === undefined) delete keybinds[name]
        else keybinds[name] = value
        draft.keybinds = keybinds as typeof draft.keybinds
      })
      .then(() => {
        const clash = conflicts(name)
        if (clash.length)
          toast.show({
            variant: "warning",
            message: t("{key} is also bound to: {commands}", { key: current(name), commands: clash.join(", ") }),
            duration: 6000,
          })
      })
      .catch(toast.error)

  const edit = (name: Name) =>
    dialog.replace(() => (
      <DialogPrompt
        title={t(TuiKeybind.Definitions[name].description)}
        placeholder={t("ctrl+k, <leader>k, alt+shift+up… · none disables · empty resets")}
        value={current(name)}
        onCancel={() => dialog.replace(() => <DialogKeybinds />)}
        onConfirm={(text) => {
          const value = text.trim()
          if (value && !validBinding(value)) {
            toast.show({ variant: "error", message: t("Not a valid key binding: {value}", { value }) })
            return
          }
          void save(name, value === "" ? undefined : value).then(() => dialog.replace(() => <DialogKeybinds />))
        }}
      />
    ))

  return (
    <DialogSelect
      title={t("Keyboard shortcuts")}
      options={options()}
      filterThreshold={0.6}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => edit(option.value)}
      footerHints={[
        { title: t("change"), label: "enter" },
        { title: t("reset"), label: "ctrl+r" },
        { title: t("disable"), label: "delete" },
      ]}
      bindings={[
        {
          bind: "ctrl+r",
          title: "Reset to default",
          group: "Shortcuts",
          run: () => {
            const name = selected()
            if (name) void save(name, undefined)
          },
        },
        {
          // ctrl+x is the leader key, so disabling sits on delete.
          bind: "delete",
          title: "Disable shortcut",
          group: "Shortcuts",
          run: () => {
            const name = selected()
            if (name) void save(name, "none")
          },
        },
      ]}
    />
  )
}

const decode = Schema.decodeUnknownOption(TuiKeybind.BindingValueSchema)

// A binding is a comma-separated list of key sequences; each part needs at least one key name.
function validBinding(value: string) {
  if (value === "none") return true
  if (decode(value)._tag === "None") return false
  return value.split(",").every((part) => /^(<leader>\s*)?[a-z0-9]/i.test(part.trim()) || /^[\[\]?\/\-=.]$/.test(part.trim()))
}
