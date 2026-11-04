import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { DialogSelect } from "../ui/dialog-select"
import { type DialogContext, useDialog } from "../ui/dialog"
import { COMMAND_PALETTE_COMMAND, Keymap, type KeymapCommand } from "../context/keymap"
import { useT } from "../util/i18n"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { listedCommand } from "../util/developer"
import { DialogConfig, settingID, settings } from "./dialog-config"
import { commandCategory, commandCategoryRank } from "./command-categories"
import { CategoryRail } from "../ui/category-rail"

function isSuggestedPaletteCommand(command: KeymapCommand) {
  const suggested = command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

const ALL = "all"
const SUGGESTED = "suggested"
const settingCategoryID = (category: string) => `setting:${category}`

/**
 * Ctrl+P browses by category, like /settings: the rail picks the group, the
 * list beside it shows only that group, and search narrows within the selected
 * category (All searches everything). Settings live in their own rail entries
 * (ids prefixed `setting:`) so they are browsable without typing their names
 * and can never collide with a command category of the same name.
 */
export function CommandPaletteDialog() {
  const commands = Keymap.useCommands()
  const shortcuts = Keymap.useShortcuts()
  const t = useT()
  const config = useConfig()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()

  onMount(() => dialog.setSize("large"))
  onCleanup(() => dialog.setSize("medium"))

  const commandOptions = createMemo(() =>
    [...commands()].flatMap((command) => {
        if (!command.id || !command.palette || command.id === COMMAND_PALETTE_COMMAND) return []
        if (!listedCommand(command.id, config.data.developer)) return []
        const footer = shortcuts.all(command.id)
        const category = commandCategory(command.group)
        return [{
          title: t(command.title ?? command.id),
          description: command.description && t(command.description),
          category,
          categoryLabel: t(category),
          // The English title and the keybind stay searchable when the palette reads in another language.
          searchText: [command.id, command.title, command.description, footer].filter(Boolean).join(" "),
          searchFooter: [category, footer].filter(Boolean).join(" · "),
          footer,
          value: command.id,
          suggested: isSuggestedPaletteCommand(command),
          onSelect: (dialog: DialogContext) => {
            dialog.clear()
            command.run()
          },
        }]
      })
      .sort((a, b) => {
        const rank = commandCategoryRank(a.category) - commandCategoryRank(b.category)
        if (rank !== 0) return rank
        const category = a.category.localeCompare(b.category)
        if (category !== 0) return category
        return a.title.localeCompare(b.title)
      }),
  )

  const settingOptions = createMemo(() =>
    settings.map((setting) => ({
      title: t(setting.title),
      category: setting.category,
      categoryLabel: t(setting.category),
      searchText: [setting.title, ...(setting.keywords ?? [])].join(" "),
      searchFooter: `${t("Settings")} · ${t(setting.category)}`,
      value: `setting:${settingID(setting)}`,
      suggested: false,
      onSelect: (dialog: DialogContext) => {
        dialog.replace(() => <DialogConfig current={settingID(setting)} />)
      },
    })),
  )

  const categories = createMemo(() => {
    const commandCategories = new Map<string, number>()
    for (const option of commandOptions()) {
      commandCategories.set(option.category, (commandCategories.get(option.category) ?? 0) + 1)
    }
    const orderedCommandCategories = [...commandCategories.entries()].sort((a, b) => {
      const rank = commandCategoryRank(a[0]) - commandCategoryRank(b[0])
      if (rank !== 0) return rank
      return a[0].localeCompare(b[0])
    })
    const settingCategories = new Map<string, number>()
    for (const setting of settings) {
      settingCategories.set(setting.category, (settingCategories.get(setting.category) ?? 0) + 1)
    }
    return [
      { id: ALL, label: t("All"), count: commandOptions().length + settingOptions().length },
      {
        id: SUGGESTED,
        label: t("Suggested"),
        count: commandOptions().filter((option) => option.suggested).length,
      },
      ...orderedCommandCategories.map(([category, count]) => ({
        id: category,
        label: t(category),
        count,
      })),
      ...[...settingCategories.entries()].map(([category, count]) => ({
        id: settingCategoryID(category),
        // A settings section whose name matches a command category is marked,
        // so the two rail entries never read as duplicates.
        label: commandCategories.has(category) ? `${t(category)} · ${t("Settings")}` : t(category),
        count,
      })),
    ]
  })

  const [selectedCategory, setSelectedCategory] = createSignal(ALL)
  const activeCategory = createMemo(
    () => categories().find((category) => category.id === selectedCategory()) ?? categories()[0],
  )

  function cycleCategory(direction: number) {
    const cats = categories()
    const idx = cats.findIndex((category) => category.id === activeCategory().id)
    setSelectedCategory(cats[(idx + direction + cats.length) % cats.length].id)
  }

  const options = createMemo(() => {
    const id = activeCategory().id
    const commands =
      id === ALL
        ? commandOptions()
        : id === SUGGESTED
          ? commandOptions().filter((option) => option.suggested)
          : id.startsWith("setting:")
            ? []
            : commandOptions().filter((option) => option.category === id)
    const settingList =
      id === ALL
        ? settingOptions()
        : id.startsWith("setting:")
          ? settingOptions().filter((option) => settingCategoryID(option.category) === id)
          : []
    // Category labels ride along only in the All view, where rows from
    // different groups mix; inside one category they would repeat on every row.
    return [...commands, ...settingList].map((option) => ({
      ...option,
      category: id === ALL ? option.categoryLabel : undefined,
    }))
  })

  return (
    <box flexDirection="row" flexGrow={1}>
      <CategoryRail items={categories()} selected={activeCategory().id} onSelect={setSelectedCategory} />
      <DialogSelect
        title={t("Commands")}
        titleView={
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
              {activeCategory().label}
            </text>
            <text fg={theme.text.muted}>{`· ${options().length} ${t("options")}`}</text>
          </box>
        }
        options={options()}
        flat={true}
        filterThreshold={0.7}
        footer={
          <box flexDirection="row" justifyContent="flex-end" width="100%" paddingTop={1}>
            <text fg={theme.text.muted}>{`tab ${t("category")} · shift+tab ${t("previous")}`}</text>
          </box>
        }
        bindings={[
          {
            bind: "tab",
            title: "Next category",
            group: "Dialog",
            run: () => cycleCategory(1),
          },
          {
            bind: "shift+tab",
            title: "Previous category",
            group: "Dialog",
            run: () => cycleCategory(-1),
          },
        ]}
      />
    </box>
  )
}
