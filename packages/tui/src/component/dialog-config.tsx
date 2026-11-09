import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { useConfig } from "../config"
import { useTheme, useThemes } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"
import { CategoryRail } from "../ui/category-rail"
import { UserNameEdit } from "./user-name-bar"
import { SculkSprite } from "./sculk-sprite-view"

type Setting = {
  title: string
  category: string
  description: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  keywords?: readonly string[]
}

const toggle = { values: [false, true], labels: ["off", "on"] } as const

// Only choices a person must make themselves belong here: language, look,
// safety, how much detail they read, and whether they want to be interrupted.
// Everything else the interface used to ask about now lives on its resolved
// default in `../config` (animations and the mascot on, sidebar and tabs on
// auto, auto-compact and the context governor on, mouse on, platform copy
// behavior, launch-directory sessions, branch diffs). Those config keys stay
// readable from the config file for anyone who goes looking; they are not
// questions the dialog asks. In-session controls keep their own toggles
// (thinking visibility has a session command, the diff viewer picks its
// own source, the DevTools bar follows Developer mode and the channel).
export const settings: Setting[] = [
  { title: "Имя пользователя", category: "General", description: "Как ИИ обращается к вам. Нажмите, чтобы изменить.", path: ["user_name"], default: "vibecoder" },
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
    title: "Verbosity",
    category: "Chat",
    description: "Low summarizes each run of tools and thoughts, high expands every group",
    path: ["session", "verbosity"],
    default: "medium",
    values: ["low", "medium", "high"],
    keywords: ["detail", "activity", "summary", "transcript"],
  },
  {
    title: "Image previews",
    category: "Chat",
    description: "Show image attachment previews above the prompt input",
    path: ["prompt", "image_preview"],
    default: false,
    ...toggle,
    keywords: ["image preview", "images", "pictures", "attachments"],
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
    title: "Developer mode",
    category: "Developer",
    description: "List debugging and rarely used commands in the command palette and slash menu",
    path: ["developer"],
    default: false,
    ...toggle,
    keywords: ["developer", "debug commands", "разработчик"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const toast = useToast()
  const themes = useThemes()
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

  const categories = createMemo(() => ["All", ...Array.from(new Set(settings.map((s) => s.category)))])
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
  const currentSetting = createMemo(() => settings[selected()])
  const [saving, setSaving] = createSignal(false)
  const [vibrating, setVibrating] = createSignal(false)
  let settle: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(settle))

  const stored = (setting: Setting) =>
    setting.path.reduce<unknown>((result, key) => {
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
    const index = setting.values?.indexOf(current)
    return t(index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current)))
  }
  const defaultDisplay = (setting?: Setting) => {
    if (!setting) return ""
    const index = setting.values?.indexOf(setting.default)
    return t(index === undefined || index < 0 ? String(setting.default) : setting.labels?.[index] ?? String(setting.default))
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
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        if (next === undefined) delete parent[setting.path.at(-1)!]
        else parent[setting.path.at(-1)!] = next
      })
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
    if (settingID(setting) === "user_name") return dialog.replace(() => <UserNameEdit />)
    const current = value(setting)
    const choices = values(setting)
    if (!choices) return
    const next = choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
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
    <box flexDirection="row" width="100%" minWidth={0}>
      <CategoryRail
        width={20}
        items={railItems()}
        selected={selectedCategory()}
        onSelect={setSelectedCategory}
        footer={
          // The sensor shivers whenever a setting is saved, like a sculk sensor catching a step.
          <SculkSprite kind="sensor" state={vibrating() ? "vibrating" : "idle"} backdrop={theme.background.base} />
        }
      />
      <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <DialogSelect
      compact
      tall
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
        <box flexDirection="column" gap={0} width="100%">
          <text fg={theme.text.base} wrapMode="word">{t(currentSetting()?.description ?? "")}</text>
          <box flexDirection="row" gap={1} flexWrap="wrap">
            <Show when={currentSetting() && changed(currentSetting()!)}><text fg={theme.text.muted}>{`${t("Current value")}: ${currentSetting() ? display(currentSetting()!) : ""} · ${t("Default value")}: ${defaultDisplay(currentSetting())}`}</text></Show>
            <text fg={theme.text.muted}>{`←/→ ${t("change")} · Tab ${t("category")} · Alt+↑/↓ ${t("section")} · Ctrl+R ${t("reset")}`}</text>
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
    </box>
  )
}
