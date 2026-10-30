import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { useConfig } from "../config"
import { useClient } from "../context/client"
import { useTheme, useThemes } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"
import { CategoryRail } from "../ui/category-rail"
import { SculkSprite } from "./sculk-sprite-view"

type Setting = {
  title: string
  category: string
  description: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
  // Lives in the server's config, not the interface's: read from its config entries and written through its API.
  remote?: {
    read: (entries: readonly any[]) => unknown
    write: (client: ReturnType<typeof useClient>, value: unknown) => Promise<unknown>
  }
}

const toggle = { values: [false, true], labels: ["off", "on"] } as const

// Ordered by how often a setting is reached for: General holds what most
// people change once after installing, Advanced what only tuning needs.
export const settings: Setting[] = [
  {
    title: "Language",
    category: "General",
    description: "Interface language of the panels, dialogs and commands",
    path: ["language"],
    default: "en",
    values: ["en", "ru"],
    labels: ["English", "Русский"],
    keywords: ["language", "russian", "english", "язык", "русский"],
  },
  {
    title: "AI language",
    category: "General",
    description: "Language the AI thinks and answers in; you can still write in any language",
    path: ["ai_language"],
    default: "auto",
    values: ["auto", "ru", "en"],
    labels: ["any", "Русский", "English"],
    keywords: ["ai language", "answer language", "язык ии", "язык ответа", "russian", "english"],
  },
  {
    title: "Theme",
    category: "General",
    description: "Color theme; /themes previews them",
    path: ["theme", "name"],
    default: "orchestra",
    keywords: ["color scheme", "colors"],
  },
  {
    title: "Layout",
    category: "Appearance",
    description: "Compact narrows the project panel and docks the sidebar beside the chat; mobile fits a phone screen",
    path: ["layout"],
    default: "auto",
    values: ["auto", "compact", "full", "mobile"],
    keywords: ["panels", "laptop", "narrow", "phone", "termux"],
  },
  {
    title: "Permissions",
    category: "Agent",
    description: "Ask before the AI runs commands and edits files, or accept automatically",
    path: ["session", "permissions"],
    default: "prompt",
    values: ["prompt", "autoaccept"],
    labels: ["prompt", "auto accept"],
    keywords: ["approve", "accept", "permission requests", "yolo"],
  },
  {
    title: "New session location",
    category: "Agent",
    description: "Start new sessions in the launch directory or in the active session's directory",
    path: ["session", "new_location"],
    default: "launch",
    values: ["launch", "inherit"],
    labels: ["launch directory", "active session"],
    keywords: ["directory", "cwd", "inherit"],
  },
  {
    title: "Animations",
    category: "Appearance",
    description: "Spinners, shimmer and other motion",
    path: ["animations"],
    default: true,
    ...toggle,
    keywords: ["motion", "effects"],
  },
  {
    title: "Mascot",
    category: "Appearance",
    description: "The Orchestra mascot beside the prompt",
    path: ["mascot"],
    default: true,
    ...toggle,
    keywords: ["character", "sprite"],
  },
  {
    title: "Sidebar",
    category: "Appearance",
    description: "Session sidebar with context, todos and MCP; auto shows it when there is room",
    path: ["session", "sidebar"],
    default: "auto",
    values: ["hide", "auto"],
    keywords: ["side panel"],
  },
  {
    title: "Thinking",
    category: "Chat",
    description: "Show the model's reasoning in the transcript",
    path: ["session", "thinking"],
    default: "hide",
    values: ["hide", "show"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Verbosity",
    category: "Chat",
    description: "Low summarizes each run of tools and thoughts, high expands every group",
    path: ["session", "verbosity"],
    default: "medium",
    values: ["low", "medium", "high"],
    keywords: ["detail", "activity", "summary", "transcript"],
  },
  {
    title: "TPS",
    category: "Chat",
    description: "Show average tokens per second of the model",
    path: ["session", "tps"],
    default: true,
    ...toggle,
    keywords: ["tokens per second", "throughput", "speed"],
  },
  {
    title: "Auto-compact",
    category: "Agent",
    description: "Compress the conversation automatically when it nears the context limit",
    path: ["compaction", "auto"],
    default: true,
    ...toggle,
    keywords: ["auto compact", "summarize", "context", "compaction", "compress"],
  },
  {
    title: "Context governor",
    category: "Agent",
    description:
      "Experimental: leave old, bulky tool output out of requests to save tokens. The saved conversation keeps everything",
    path: ["experimental", "context_governor"],
    default: false,
    ...toggle,
    keywords: ["tokens", "context", "cost", "save", "experimental", "токены", "контекст", "экономия"],
    remote: {
      read: (entries) =>
        entries.findLast((entry) => entry?.type === "document" && entry.info?.experimental?.context_governor !== undefined)
          ?.info.experimental.context_governor,
      write: (client, value) => client.api.config.update({ contextGovernor: value === undefined ? null : Boolean(value) }),
    },
  },
  {
    title: "Tabs",
    category: "Workspace",
    description: "Session tabs: always, never, or when the terminal supports them",
    path: ["tabs", "mode"],
    default: "auto",
    values: ["off", "on", "auto"],
  },
  {
    title: "Diff source",
    category: "Workspace",
    description: "What /diff opens with: branch changes, working tree, commits or the last turn",
    path: ["diffs", "source"],
    default: "branch",
    values: ["branch", "working", "committed", "turn"],
    labels: ["branch", "uncommitted", "committed", "last turn"],
    keywords: ["diff source", "changes", "turn"],
  },
  {
    title: "Mouse",
    category: "Input",
    description: "Clicks and scrolling with the mouse; off leaves selection to the terminal",
    path: ["mouse"],
    default: true,
    ...toggle,
    keywords: ["mouse capture"],
  },
  {
    title: "Notifications",
    category: "Notifications",
    description: "System notification when the AI finishes or needs an answer",
    path: ["attention", "notifications"],
    default: false,
    ...toggle,
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds",
    category: "Notifications",
    description: "Play a sound when the AI finishes or needs an answer",
    path: ["attention", "sound"],
    default: false,
    ...toggle,
    keywords: ["audio", "sound effects", "alerts"],
  },
  {
    title: "Copy behavior",
    category: "Input",
    description: "Copy as soon as text is selected, or only on request",
    path: ["terminal", "copy"],
    default: process.platform === "win32" ? "manual" : "select",
    values: ["manual", "select"],
    keywords: ["selection", "clipboard"],
  },
  {
    title: "Developer mode",
    category: "Developer",
    description: "List debugging and rarely used commands in the command palette and slash menu",
    path: ["developer"],
    default: false,
    ...toggle,
    keywords: ["developer", "debug commands", "разработчик"],
  },
  {
    title: "Developer tools",
    category: "Developer",
    description: "Bottom bar with server, UI, Tools and Registry",
    path: ["debug", "devtools"],
    default: false,
    ...toggle,
    keywords: ["debug bar", "developer tools"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const client = useClient()
  const toast = useToast()
  const themes = useThemes()
  const [remote, { refetch }] = createResource(() => client.api.config.get().catch(() => undefined))
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const t = useT()

  // Enlarge settings dialog to large for a spacious, professional next-gen layout
  onMount(() => {
    dialog.setSize("large")
  })
  onCleanup(() => {
    dialog.setSize("medium")
  })

  const categories = createMemo(() => [
    "All",
    ...Array.from(new Set(settings.map((s) => s.category))),
  ])
  const [selectedCategory, setSelectedCategory] = createSignal("All")

  function cycleCategory(direction: number) {
    const cats = categories()
    const idx = cats.indexOf(selectedCategory())
    const next = cats[(idx + direction + cats.length) % cats.length]
    setSelectedCategory(next)
  }

  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)
  const [vibrating, setVibrating] = createSignal(false)
  let settle: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(settle))

  const stored = (setting: Setting) =>
    setting.remote
      ? setting.remote.read(Array.isArray(remote()) ? (remote() as any[]) : [])
      : setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
  const value = (setting: Setting) => {
    if (settingID(setting) === "theme.name") return stored(setting) ?? themes.selected
    return stored(setting) ?? setting.default
  }
  const values = (setting: Setting) =>
    settingID(setting) === "theme.name"
      ? Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return t(index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current)))
  }
  const changed = (setting: Setting) => stored(setting) !== undefined && value(setting) !== setting.default

  const filteredSettings = createMemo(() => {
    const cat = selectedCategory()
    return cat === "All" ? settings : settings.filter((s) => s.category === cat)
  })

  const options = createMemo(() =>
    filteredSettings().map((setting) => {
      const globalIndex = settings.indexOf(setting)
      return {
        title: t(setting.title),
        category: selectedCategory() === "All" ? t(setting.category) : undefined,
        // English words stay searchable when the dialog reads in another language.
        searchText: [setting.title, setting.category, t(setting.description), ...(setting.keywords ?? [])].join(" "),
        footer: (changed(setting) ? "● " : "") + display(setting),
        footerColor: changed(setting) ? theme.text.formfield.selected : undefined,
        value: globalIndex,
      }
    }),
  )

  async function write(next: unknown, index: number) {
    const setting = settings[index]
    setSaving(true)
    await (setting.remote
      ? setting.remote.write(client, next).then(() => refetch())
      : config.update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        if (next === undefined) delete parent[setting.path.at(-1)!]
        else parent[setting.path.at(-1)!] = next
      }))
      .then(() => {
        setVibrating(true)
        clearTimeout(settle)
        settle = setTimeout(() => setVibrating(false), 1200)
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  function change(direction: number, index = selected()) {
    if (saving()) return
    const setting = settings[index]
    if (!setting) return
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    return write(next, index)
  }

  // Removing the key, rather than writing the default, keeps the config file
  // free of values the user never chose and follows future default changes.
  function reset(index = selected()) {
    if (saving() || stored(settings[index]) === undefined) return
    return write(undefined, index)
  }

  const railItems = createMemo(() =>
    categories().map((id) => ({
      id,
      label: t(id),
      count: id === "All" ? settings.length : settings.filter((setting) => setting.category === id).length,
    })),
  )

  return (
    <box flexDirection="row" flexGrow={1}>
      <CategoryRail
        items={railItems()}
        selected={selectedCategory()}
        onSelect={setSelectedCategory}
        footer={
          // The sensor shivers whenever a setting is saved, like a sculk sensor catching a step.
          <SculkSprite kind="sensor" state={vibrating() ? "vibrating" : "idle"} backdrop={theme.background.base} />
        }
      />
      <DialogSelect
      title={t("Settings")}
      titleView={
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            {selectedCategory() === "All" ? t("Settings") : t(selectedCategory())}
          </text>
          <text fg={theme.text.muted}>{`· ${filteredSettings().length} ${t("options")}`}</text>
        </box>
      }
      options={options()}
      focusTarget={current}
      filterThreshold={0.7}
      sectionNavigation={true}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => void change(1, option.value)}
      footer={
        <box flexDirection="column" gap={0} paddingTop={1} border={["top"]} borderColor={theme.border.base} width="100%">
          <box flexDirection="row" justifyContent="space-between" width="100%" alignItems="flex-start">
            <box flexGrow={1} minWidth={0} paddingRight={2}>
              <text fg={theme.text.base} wrapMode="word">
                {t(settings[selected()]?.description ?? "")}
              </text>
              <box flexDirection="row" gap={2} paddingTop={0}>
                <text fg={theme.text.muted}>
                  path: <span style={{ fg: theme.text.base }}>{settings[selected()] ? settingID(settings[selected()]) : ""}</span>
                </text>
                <Show when={settings[selected()]?.default !== undefined}>
                  <text fg={theme.text.muted}>
                    default: <span style={{ fg: theme.text.base }}>{String(settings[selected()]?.default)}</span>
                  </text>
                </Show>
                <Show when={settings[selected()] && changed(settings[selected()])}>
                  <text fg={theme.text.action.primary.base} attributes={TextAttributes.BOLD}>
                    ● {t("modified")}
                  </text>
                </Show>
              </box>
            </box>
            <box flexDirection="column" flexShrink={0} alignItems="flex-end">
              <text fg={theme.text.muted}>
                {`←/→ ${t("change")} · tab ${t("category")}`}
              </text>
              <text fg={theme.text.muted}>
                {`alt+↑/↓ ${t("section")} · ctrl+r ${t("reset")}`}
              </text>
            </box>
          </box>
        </box>
      }
      bindings={[
        {
          bind: "left",
          title: "Previous value",
          group: "Settings",
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: "Next value",
          group: "Settings",
          run: () => void change(1),
        },
        {
          bind: "tab",
          title: "Next category",
          group: "Settings",
          run: () => cycleCategory(1),
        },
        {
          bind: "shift+tab",
          title: "Previous category",
          group: "Settings",
          run: () => cycleCategory(-1),
        },
        {
          bind: "ctrl+r",
          title: "Reset to default",
          group: "Settings",
          run: () => void reset(),
        },
      ]}
      />
    </box>
  )
}
