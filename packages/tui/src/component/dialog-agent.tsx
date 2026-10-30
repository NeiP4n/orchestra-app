import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { OrchestraRole } from "@orchestra/client/promise"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { CategoryRail } from "../ui/category-rail"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useT } from "../util/i18n"

const AGENTS = "Agents"
const TEAM = "Team roles"

// Team roles register as "team-" agents, so a plain list of every agent runs to dozens of rows.
// The panel groups them: the operator's own agents first, then each role category in the order
// the roles are listed. shift+tab, which opens the panel, keeps walking it; enter switches.
export function agentOptions(
  agents: readonly { id: string; name: string; description?: string }[],
  roles: readonly Pick<OrchestraRole, "agent" | "name" | "description" | "category">[],
  t: (text: string) => string = (text) => text,
): DialogSelectOption<string>[] {
  const roleOf = new Map(roles.map((role) => [role.agent as string, role]))
  const order = [...new Set(roles.map((role) => role.category || TEAM))]
  const rank = (category: string) => (category === AGENTS ? -1 : order.indexOf(category) + 1 || order.length + 1)
  return agents
    .map((agent, index) => {
      const role = roleOf.get(agent.id)
      const category = role ? role.category || TEAM : agent.id.startsWith("team-") ? TEAM : AGENTS
      return {
        index,
        category,
        option: {
          value: agent.id,
          title: t(role?.name ?? agent.name),
          description: role?.description ?? agent.description,
          category: t(category),
          searchText: agent.id,
        },
      }
    })
    .toSorted((a, b) => rank(a.category) - rank(b.category) || a.index - b.index)
    .map((item) => item.option)
}

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const client = useClient()
  const t = useT()
  // Without the role list (an older server, say) team agents still group under one heading.
  const [roles] = createResource(() => client.api.orchestra.role.list().catch(() => []))
  let select: DialogSelectRef<string> | undefined

  const all = createMemo(() => agentOptions(local.agent.list(), roles() ?? [], t))

  // Like Settings: a rail of categories with counts beside the list. "" is every category; the rail
  // hides itself on narrow terminals and the list keeps its section headings.
  const [category, setCategory] = createSignal("")
  const rail = createMemo(() => {
    const names = [...new Set(all().map((option) => option.category ?? ""))]
    return [
      { id: "", label: t("All"), count: all().length },
      ...names.map((id) => ({ id, label: id, count: all().filter((option) => option.category === id).length })),
    ]
  })
  const options = createMemo(() =>
    category() === ""
      ? all()
      : all()
          .filter((option) => option.category === category())
          .map((option) => ({ ...option, category: undefined })),
  )

  onMount(() => dialog.setSize("large"))
  onCleanup(() => dialog.setSize("medium"))

  const step = (direction: 1 | -1) => {
    if (!select) return
    const list = select.filtered
    if (list.length === 0) return
    const index = list.findIndex((option) => option.value === select?.selected?.value)
    select.moveTo(list[(index + direction + list.length) % list.length].value)
  }

  return (
    <box flexDirection="row" flexGrow={1}>
      <CategoryRail items={rail()} selected={category()} onSelect={setCategory} />
      <DialogSelect
      title={t("Select agent")}
      current={local.agent.current()?.id}
      options={options()}
      ref={(ref) => (select = ref)}
      sectionNavigation
      tall
      bindings={[
        { bind: "shift+tab", title: "Next agent", group: "Dialog", run: () => step(1) },
        { bind: "tab", title: "Previous agent", group: "Dialog", run: () => step(-1) },
      ]}
      footerHints={[
        { title: t("next"), label: "shift+tab" },
        { title: t("sections"), label: "alt+↑↓", side: "right" },
      ]}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
      />
    </box>
  )
}
