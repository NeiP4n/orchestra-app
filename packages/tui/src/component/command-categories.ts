/**
 * The single categorization standard for commands.
 *
 * Every command registers a free-form `group` string, and over time the same
 * concept picked up several spellings ("Git" next to "VCS", "Dialogs" next to
 * "Dialog", "Group" next to "Project"). Menus, the command palette and the
 * which-key panel must not show those as separate categories, so all category
 * labels shown to the user go through `commandCategory` first: it maps legacy
 * spellings onto the canonical list and gives the categories one stable order.
 *
 * Canonical order is task-first: the things a user does with a session come
 * before configuration, and configuration before diagnostics/meta groups.
 */
export const COMMAND_CATEGORIES = [
  "Session",
  "Agent",
  "Model",
  "Project",
  "Workspace",
  "Prompt",
  "Composer",
  "Execute",
  "Shell",
  "VCS",
  "Diff",
  "View",
  "Tabs",
  "Form",
  "Autocomplete",
  "Dialog",
  "Permission",
  "Connect",
  "Teams",
  "Plugins",
  "Registry",
  "Settings",
  "System",
  "Shortcuts",
  "Experiments",
  "Debug",
  "Freebuff",
  "Mini skills",
  "Other",
] as const

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number]

/** Legacy or duplicate group spellings and the canonical category they belong to. */
const ALIASES: Record<string, CommandCategory> = {
  Git: "VCS",
  Dialogs: "Dialog",
  Group: "Project",
  Groups: "Project",
}

const KNOWN = new Set<string>(COMMAND_CATEGORIES)

/**
 * Resolve a command's raw group to the category label menus should display.
 * Unknown groups keep their (trimmed) spelling so a plugin's own category is
 * never silently hidden; they sort after every canonical category.
 */
export function commandCategory(group: string | undefined): string {
  const trimmed = group?.trim()
  if (!trimmed) return "Other"
  return ALIASES[trimmed] ?? trimmed
}

/** Position of a category in the canonical order; unknown categories go last, alphabetically among themselves. */
export function commandCategoryRank(group: string | undefined): number {
  const category = commandCategory(group)
  const index = (COMMAND_CATEGORIES as readonly string[]).indexOf(category)
  return index === -1 ? COMMAND_CATEGORIES.length : index
}

/** Comparator for sorting commands or menu entries by canonical category, then by label. */
export function compareCommandCategories(
  a: { group?: string; label: string },
  b: { group?: string; label: string },
): number {
  const rank = commandCategoryRank(a.group) - commandCategoryRank(b.group)
  if (rank !== 0) return rank
  const category = commandCategory(a.group).localeCompare(commandCategory(b.group))
  if (category !== 0) return category
  return a.label.localeCompare(b.label)
}

export function isKnownCommandCategory(group: string | undefined): group is CommandCategory {
  return group !== undefined && KNOWN.has(commandCategory(group))
}
