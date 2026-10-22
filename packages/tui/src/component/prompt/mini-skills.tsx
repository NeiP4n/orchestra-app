import { BoxRenderable, MouseEvent, TextareaRenderable } from "@opentui/core"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { readFile, mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Keymap } from "../../context/keymap"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../ui/dialog-select"
import { hoverBackground } from "../../ui/hover"
import { neuralPalette } from "../neural"
import { useToast } from "../../ui/toast"
import { useConfig } from "../../config"
import { stringWidth } from "../../util/string-width"
import { useT } from "../../util/i18n"

export type MiniSkill = {
  id: string
  label: string
  icon: string
  instruction: string
  // Kept in the list but left off the bar above the prompt.
  hidden?: boolean
}

// Ready-made mini skills. The first six start on the bar; the rest wait in the manager
// until the operator adds them, and a removed one can be added back from there.
const PRESETS: (MiniSkill & { starter?: true })[] = [
  {
    id: "analyze",
    label: "Analyze",
    icon: "◎",
    starter: true,
    instruction:
      "Analyze the request and relevant code carefully. Identify the root cause, constraints, and risks before making changes.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: "≡",
    starter: true,
    instruction:
      "First inspect the repository and create a concise implementation plan with concrete steps and validation. Then carry it out.",
  },
  {
    id: "debug",
    label: "Debug",
    icon: "⌕",
    starter: true,
    instruction:
      "Investigate the root cause before changing code. Reproduce the issue when possible, trace the relevant paths, then fix and verify it.",
  },
  {
    id: "review",
    label: "Review",
    icon: "✓",
    starter: true,
    instruction:
      "Review the relevant changes for correctness, regressions, edge cases, security, and maintainability. Fix any confirmed problems.",
  },
  {
    id: "test",
    label: "Test",
    icon: "T",
    starter: true,
    instruction:
      "Identify the relevant test coverage, run the most targeted tests first, add regression tests where appropriate, and report the actual results.",
  },
  {
    id: "explain",
    label: "Explain",
    icon: "?",
    starter: true,
    instruction:
      "Explain the relevant implementation in clear, practical language. Trace how the pieces interact and distinguish verified facts from assumptions.",
  },
  {
    id: "security",
    label: "Security",
    icon: "!",
    instruction:
      "Audit the relevant code for vulnerabilities: follow untrusted input to where it is used, and check authorization, injection, secrets and races. Report each finding with file, line, an input that exploits it and the fix.",
  },
  {
    id: "refactor",
    label: "Refactor",
    icon: "↻",
    instruction:
      "Refactor the relevant code without changing its behavior. Run the tests before and after, work in small steps, and report what got simpler.",
  },
  {
    id: "perf",
    label: "Speed up",
    icon: "»",
    instruction:
      "Find out why this is slow: measure first, locate the hot spot, make one focused fix and report the numbers before and after.",
  },
  {
    id: "docs",
    label: "Docs",
    icon: "¶",
    instruction:
      "Update the documentation for what changed. Check every command and example against the current code, and keep the existing structure and tone.",
  },
  {
    id: "commit",
    label: "Commit",
    icon: "◆",
    instruction:
      "Review git status and the diff, then commit only the changes from this task with a conventional commit message. Do not push.",
  },
]

const defaults = () => PRESETS.filter((preset) => preset.starter).map(({ starter: _, ...skill }) => ({ ...skill }))

type ManagerEntry = { kind: "skill"; skill: MiniSkill } | { kind: "preset"; skill: MiniSkill } | { kind: "add" }
type SkillAction = "insert" | "toggle" | "edit" | "remove" | "top" | "up" | "down" | "bottom"

function normalizeSkills(value: unknown): MiniSkill[] | undefined {
  if (!Array.isArray(value)) return
  const result: MiniSkill[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const candidate = item as Record<string, unknown>
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.instruction !== "string"
    )
      continue
    const label = candidate.label.trim()
    const instruction = candidate.instruction.trim()
    if (!label || !instruction) continue
    result.push({
      id: candidate.id,
      label: label.slice(0, 48),
      icon: typeof candidate.icon === "string" && candidate.icon.trim() ? candidate.icon.trim().slice(0, 4) : "✦",
      instruction,
      ...(candidate.hidden === true ? { hidden: true } : {}),
    })
  }
  return result
}

async function persistMiniSkills(filePath: string, skills: MiniSkill[]) {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, items: skills }, null, 2) + "\n", "utf8")
  await rename(temporary, filePath)
}

// Moves one skill by delta places, or to an end with -Infinity / Infinity.
export function moveSkill(items: MiniSkill[], id: string, delta: number) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return items
  const target = Math.max(0, Math.min(items.length - 1, index + delta))
  if (target === index) return items
  const next = items.toSpliced(index, 1)
  return next.toSpliced(target, 0, items[index])
}

// Puts a skill where another one stands: after it when dragged rightwards, before it when
// dragged leftwards, the way chips trade places under the pointer.
export function placeSkill(items: MiniSkill[], id: string, targetID: string) {
  const from = items.findIndex((item) => item.id === id)
  const to = items.findIndex((item) => item.id === targetID)
  if (from < 0 || to < 0) return items
  return moveSkill(items, id, to - from)
}

const RIGHT_MOUSE_BUTTON = 2

// The leading skills whose chips fit in width, after reserving the settings chip and, when
// some skills are left over, the "+N" chip before it. Chips are one cell apart.
export function fittingSkills(
  skills: MiniSkill[],
  width: number,
  chipWidth: (skill: MiniSkill) => number,
  settings: number,
  more: number,
) {
  const fit = (count: number, used: number): number => {
    if (count === skills.length) return count
    const next = used + chipWidth(skills[count]) + 1
    const tail = settings + (count + 1 < skills.length ? more + 1 : 0)
    return next + tail <= width ? fit(count + 1, next) : count
  }
  return skills.slice(0, fit(0, 0))
}

// A built-in skill the operator has not renamed shows in the operator's language.
function useSkillLabel() {
  const t = useT()
  return (skill: MiniSkill) =>
    PRESETS.some((preset) => preset.id === skill.id && preset.label === skill.label) ? t(skill.label) : skill.label
}

export function PromptMiniSkills(props: {
  mode: () => "normal" | "shell"
  visible?: boolean
  onInsert: (instruction: string) => void
}) {
  const paths = useTuiPaths()
  const toast = useToast()
  const t = useT()
  const label = useSkillLabel()
  const dialog = useDialog()
  const filePath = path.join(paths.state, "mini-skills.json")
  const [skills, setSkills] = createSignal<MiniSkill[]>(defaults())
  const [loaded, setLoaded] = createSignal(false)
  const [width, setWidth] = createSignal(0)
  let writes: Promise<void> = Promise.resolve()

  async function save(next: MiniSkill[]) {
    const previous = skills()
    setSkills(next)
    const task = writes.catch(() => undefined).then(() => persistMiniSkills(filePath, next))
    writes = task
    try {
      await task
    } catch (error) {
      setSkills(previous)
      toast.error(error)
      throw error
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as { items?: unknown }
        const restored = normalizeSkills(parsed?.items)
        if (!restored) throw new Error("Invalid mini-skills settings")
        setSkills(restored)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            await save(skills())
          } catch {
            // The defaults remain usable for this run even if persistence fails.
          }
        } else {
          toast.show({
            title: t("Mini skills"),
            message: t("Could not read saved mini skills; using defaults."),
            variant: "warning",
          })
        }
      } finally {
        setLoaded(true)
      }
    })()
  })

  function insert(skill: MiniSkill) {
    props.onInsert(skill.instruction)
    toast.show({ message: t("Inserted mini skill: {name}", { name: label(skill) }), variant: "info", duration: 1800 })
  }

  const manage = () => dialog.replace(() => <MiniSkillsManager skills={skills} save={save} insert={insert} />)
  const update = (next: MiniSkill[]) => void save(next).catch(() => {})
  const edit = (skill?: MiniSkill) =>
    dialog.replace(() => (
      <MiniSkillEditor
        skill={skill}
        onCancel={() => dialog.clear()}
        onSave={async (updated) => {
          const current = skills()
          const next = skill ? current.map((item) => (item.id === skill.id ? updated : item)) : [...current, updated]
          try {
            await save(next)
            dialog.clear()
          } catch {
            // Keep the editor open so the user can retry.
          }
        }}
      />
    ))

  // Dragging a chip along the bar shows the new order as it goes; letting go saves it. The
  // chip under the pointer is looked up in that shown order, and the dragged chip itself is
  // skipped, so it can be led either way, back to where it started too.
  const [dragging, setDragging] = createSignal<string>()
  const [preview, setPreview] = createSignal<MiniSkill[]>()
  const [menu, setMenu] = createSignal<{ skill: MiniSkill; x: number; y: number }>()
  const chips = new Map<string, BoxRenderable>()
  let dragged = false
  const ordered = createMemo(() => preview() ?? skills())
  const drag = (event: MouseEvent) => {
    const source = dragging()
    if (!source) return
    dragged = true
    const over = visibleSkills().find((skill) => {
      const chip = chips.get(skill.id)
      return chip && event.x >= chip.screenX && event.x < chip.screenX + chip.width
    })
    if (!over || over.id === source) return
    setPreview(placeSkill(ordered(), source, over.id))
  }
  const release = () => {
    const next = preview()
    setDragging(undefined)
    setPreview(undefined)
    if (next && next.some((skill, index) => skill.id !== skills()[index]?.id)) update(next)
    // The click that ends a drag must not also insert the chip's text.
    queueMicrotask(() => (dragged = false))
  }

  const chipWidth = (skill: MiniSkill) => stringWidth(`${skill.icon} ${label(skill)}`) + 2
  const shown = createMemo(() => ordered().filter((skill) => !skill.hidden))
  const settingsText = () => `✱ ${t("Skills")}`
  const visibleSkills = createMemo(() =>
    fittingSkills(shown(), width(), chipWidth, stringWidth(settingsText()) + 2, stringWidth("+99") + 2),
  )

  return (
    <Show
      when={loaded() && props.visible !== false && props.mode() === "normal"}
      fallback={<box height={1} flexShrink={0} />}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        height={1}
        marginBottom={1}
        width="100%"
        overflow="hidden"
        onSizeChange={function (this: BoxRenderable) {
          const next = this.width
          queueMicrotask(() => setWidth(next))
        }}
        onMouseDrag={drag}
        onMouseDragEnd={release}
        onMouseUp={release}
      >
        <For each={visibleSkills()}>
          {(skill) => (
            <Chip
              text={`${skill.icon} ${label(skill)}`}
              lifted={dragging() === skill.id}
              ref={(chip) => chips.set(skill.id, chip)}
              onPress={() => {
                dragged = false
                setDragging(skill.id)
              }}
              onContext={(event) => setMenu({ skill, x: event.x, y: event.y })}
              onClick={() => {
                if (!dragged) insert(skill)
              }}
            />
          )}
        </For>
        <Show when={shown().length > visibleSkills().length}>
          <Chip text={`+${shown().length - visibleSkills().length}`} muted onClick={manage} />
        </Show>
        <Chip text={settingsText()} muted onClick={manage} />
      </box>
      <Show when={menu()} keyed>
        {(state) => (
          <ChipMenu
            x={state.x}
            y={state.y}
            onClose={() => setMenu(undefined)}
            actions={[
              { title: t("Insert instruction"), run: () => insert(state.skill) },
              { title: t("Edit"), run: () => edit(state.skill) },
              {
                title: t("Hide from the bar"),
                run: () =>
                  update(skills().map((item) => (item.id === state.skill.id ? { ...item, hidden: true } : item))),
              },
              {
                title: t("Move to the start"),
                run: () => update(moveSkill(skills(), state.skill.id, -Infinity)),
              },
              { title: t("Move to the end"), run: () => update(moveSkill(skills(), state.skill.id, Infinity)) },
              { title: t("Remove"), run: () => update(skills().filter((item) => item.id !== state.skill.id)) },
              { title: `+ ${t("New mini skill")}`, run: () => edit() },
              { title: `✱ ${t("All mini skills")}`, run: manage },
            ]}
          />
        )}
      </Show>
    </Show>
  )
}

// A small menu at the pointer for one chip, closed by a click outside it or by escape.
function ChipMenu(props: { x: number; y: number; actions: { title: string; run: () => void }[]; onClose: () => void }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal<number>()
  onCleanup(Keymap.use().mode.push("menu"))
  Keymap.createLayer(() => ({
    mode: "menu",
    commands: [{ bind: "escape,ctrl+c", title: "Close menu", group: "Mini skills", run: props.onClose }],
  }))
  const width = () => Math.max(...props.actions.map((action) => stringWidth(action.title) + 2))
  const height = () => props.actions.length
  const top = () => Math.max(0, Math.min(props.y + 1, dimensions().height - height()))
  const left = () => Math.max(0, Math.min(props.x, dimensions().width - width()))

  return (
    <Portal
      ref={(container) => {
        if (!(container instanceof BoxRenderable)) return
        // The portal's wrapper otherwise follows the full-height app in the root layout.
        container.position = "absolute"
        container.left = 0
        container.top = 0
        container.zIndex = 2500
      }}
    >
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        zIndex={2500}
        onMouseDown={(event: MouseEvent) => {
          props.onClose()
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <box
          position="absolute"
          left={left()}
          top={top()}
          width={width()}
          height={height()}
          backgroundColor={theme.background.raised.base}
          onMouseDown={(event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <For each={props.actions}>
            {(action, index) => (
              <box
                width="100%"
                height={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected() === index() ? hoverBackground(theme) : undefined}
                onMouseOver={() => setSelected(index())}
                onMouseOut={() => setSelected(undefined)}
                onMouseUp={(event: MouseEvent) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.button !== 0) return
                  action.run()
                  props.onClose()
                }}
              >
                <text fg={theme.text.base} selectable={false} wrapMode="none" truncate>
                  {action.title}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Portal>
  )
}

// One button on the bar: flat at rest so the prompt has no gray blocks, and lit while the
// pointer is over it so it reads as clickable.
function Chip(props: {
  text: string
  muted?: boolean
  // Held by a drag in progress.
  lifted?: boolean
  ref?: (chip: BoxRenderable) => void
  onPress?: () => void
  onContext?: (event: MouseEvent) => void
  onClick: () => void
}) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const lit = () => hovered() || props.lifted
  return (
    <box
      ref={props.ref}
      height={1}
      width={stringWidth(props.text) + 2}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      // The resting fill matches the page, so the chip shows no block yet still takes the pointer.
      backgroundColor={lit() ? hoverBackground(theme) : theme.background.base}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === RIGHT_MOUSE_BUTTON && props.onContext) {
          event.preventDefault()
          event.stopPropagation()
          props.onContext(event)
          return
        }
        if (event.button === 0) props.onPress?.()
      }}
      onMouseUp={(event: MouseEvent) => {
        if (event.button !== 0) return
        props.onClick()
      }}
    >
      <text
        fg={lit() ? neuralPalette(theme).signal : props.muted ? theme.text.muted : theme.text.base}
        // A chip is pressed and dragged, not read: a drag must not start a text selection.
        selectable={false}
        wrapMode="none"
        truncate
      >
        {props.text}
      </text>
    </box>
  )
}

function MiniSkillsManager(props: {
  skills: () => MiniSkill[]
  save: (skills: MiniSkill[]) => Promise<void>
  insert: (skill: MiniSkill) => void
  focus?: string
}) {
  const dialog = useDialog()
  const t = useT()
  const label = useSkillLabel()
  let select: DialogSelectRef<ManagerEntry> | undefined
  const reopen = (focus?: string) => dialog.replace(() => <MiniSkillsManager {...props} focus={focus} />)
  const presets = createMemo(() =>
    PRESETS.filter((preset) => !props.skills().some((skill) => skill.id === preset.id)).map(
      ({ starter: _, ...skill }) => skill,
    ),
  )
  const options = createMemo<DialogSelectOption<ManagerEntry>[]>(() => [
    ...props.skills().map((skill) => ({
      title: `${skill.hidden ? "  " : "✓ "}${skill.icon} ${label(skill)}`,
      description: skill.hidden ? `${t("hidden")} · ${skill.instruction}` : skill.instruction,
      category: t("On the bar, in order"),
      value: { kind: "skill", skill } as ManagerEntry,
    })),
    {
      title: `+ ${t("New mini skill")}`,
      description: t("A button with your own prompt text"),
      category: t("Add"),
      value: { kind: "add" },
    },
    ...presets().map((skill) => ({
      title: `+ ${skill.icon} ${label(skill)}`,
      description: skill.instruction,
      category: t("Add"),
      value: { kind: "preset", skill } as ManagerEntry,
    })),
  ])

  // Every change goes back to the list with the cursor on the skill it changed.
  const apply = (next: MiniSkill[], focus?: string) =>
    void props
      .save(next)
      .then(() => reopen(focus))
      .catch(() => {})
  const toggle = (id: string) =>
    apply(
      props.skills().map((item) => (item.id === id ? { ...item, hidden: !item.hidden || undefined } : item)),
      id,
    )
  const move = (id: string, delta: number) => apply(moveSkill(props.skills(), id, delta), id)

  function edit(skill?: MiniSkill) {
    dialog.replace(() => (
      <MiniSkillEditor
        skill={skill}
        onCancel={() => reopen(skill?.id)}
        onSave={async (updated) => {
          const current = props.skills()
          const next = skill ? current.map((item) => (item.id === skill.id ? updated : item)) : [...current, updated]
          try {
            await props.save(next)
            reopen(updated.id)
          } catch {
            // Keep the editor open so the user can retry.
          }
        }}
      />
    ))
  }

  function actions(skill: MiniSkill) {
    const options: DialogSelectOption<SkillAction>[] = [
      { title: t("Insert instruction"), description: t("Add this text to the current prompt"), value: "insert" },
      {
        title: skill.hidden ? t("Show on the bar") : t("Hide from the bar"),
        description: t("It stays in this list either way"),
        value: "toggle",
      },
      { title: t("Edit"), description: t("Change the icon, the name or the prompt text"), value: "edit" },
      { title: t("Move to the start"), value: "top" },
      { title: t("Move left"), value: "up" },
      { title: t("Move right"), value: "down" },
      { title: t("Move to the end"), value: "bottom" },
      { title: t("Remove"), description: t("Delete this mini skill"), value: "remove" },
    ]
    dialog.replace(() => (
      <DialogSelect
        title={label(skill)}
        options={options}
        onCancel={() => reopen(skill.id)}
        onSelect={(option) => {
          if (option.value === "insert") {
            props.insert(skill)
            dialog.clear()
            return
          }
          if (option.value === "edit") return edit(skill)
          if (option.value === "toggle") return toggle(skill.id)
          if (option.value === "remove") return apply(props.skills().filter((item) => item.id !== skill.id))
          const delta = { top: -Infinity, up: -1, down: 1, bottom: Infinity }[option.value]
          move(skill.id, delta)
        }}
      />
    ))
  }

  const focusedSkill = () => {
    const entry = select?.selected?.value
    return entry?.kind === "skill" ? entry.skill : undefined
  }

  return (
    <DialogSelect
      title={t("Mini skills")}
      options={options()}
      preserveSelection
      focusTarget={
        props.focus === undefined
          ? undefined
          : options().find((option) => option.value.kind === "skill" && option.value.skill.id === props.focus)?.value
      }
      ref={(value) => (select = value)}
      onSelect={(option) => {
        if (option.value.kind === "add") return edit()
        if (option.value.kind === "preset") return apply([...props.skills(), option.value.skill], option.value.skill.id)
        actions(option.value.skill)
      }}
      onCancel={() => dialog.clear()}
      footerHints={[
        { title: t("show / hide"), label: "space" },
        { title: t("move"), label: "ctrl+↑↓" },
      ]}
      bindings={[
        {
          bind: "space",
          title: t("Show or hide on the bar"),
          group: t("Mini skills"),
          run: () => {
            const skill = focusedSkill()
            if (skill) toggle(skill.id)
          },
        },
        {
          bind: "ctrl+up",
          title: t("Move left"),
          group: t("Mini skills"),
          run: () => {
            const skill = focusedSkill()
            if (skill) move(skill.id, -1)
          },
        },
        {
          bind: "ctrl+down",
          title: t("Move right"),
          group: t("Mini skills"),
          run: () => {
            const skill = focusedSkill()
            if (skill) move(skill.id, 1)
          },
        },
      ]}
    />
  )
}

function MiniSkillEditor(props: {
  skill?: MiniSkill
  onSave: (skill: MiniSkill) => void | Promise<void>
  onCancel: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const t = useT()
  const config = useConfig().data
  let iconInput: TextareaRenderable
  let labelInput: TextareaRenderable
  let instructionInput: TextareaRenderable
  const fields = () => [iconInput, labelInput, instructionInput]

  function save() {
    const label = labelInput.plainText.trim()
    const instruction = instructionInput.plainText.trim()
    if (!label || !instruction) {
      toast.show({ message: t("Enter both a button name and prompt text."), variant: "warning" })
      return
    }
    void props.onSave({
      id: props.skill?.id ?? `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: label.slice(0, 48),
      icon: iconInput.plainText.trim().slice(0, 4) || "✦",
      instruction,
      ...(props.skill?.hidden ? { hidden: true } : {}),
    })
  }

  const step = (delta: number) => {
    const list = fields()
    const index = list.findIndex((field) => field?.focused)
    list[(Math.max(index, 0) + delta + list.length) % list.length]?.focus()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 2,
    commands: [
      { bind: "ctrl+s", title: t("Save mini skill"), group: t("Mini skills"), run: save },
      { bind: "escape", title: t("Back to mini skills"), group: t("Mini skills"), run: props.onCancel },
      { bind: "tab", title: t("Next field"), group: t("Mini skills"), run: () => step(1) },
      { bind: "shift+tab", title: t("Previous field"), group: t("Mini skills"), run: () => step(-1) },
    ],
  }))

  onMount(() => {
    setTimeout(() => {
      if (!labelInput || labelInput.isDestroyed) return
      labelInput.focus()
    }, 1)
    dialog.setSize("large")
  })

  const input = (initial: string, placeholder: string, ref: (value: TextareaRenderable) => void, height = 1) => (
    <textarea
      height={height}
      maxHeight={height > 1 ? 10 : 1}
      wrapMode={height > 1 ? "word" : "none"}
      initialValue={initial}
      placeholder={placeholder}
      placeholderColor={theme.text.muted}
      textColor={theme.text.formfield.base}
      focusedTextColor={theme.text.formfield.focused}
      cursorColor={theme.text.formfield.focused}
      cursorStyle={config.cursor}
      ref={ref}
    />
  )

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base}>{props.skill ? t("Edit mini skill") : t("New mini skill")}</text>
      <box flexDirection="row" gap={2}>
        <box width={8} flexShrink={0}>
          <text fg={theme.text.muted}>{t("Icon")}</text>
          {input(props.skill?.icon ?? "✦", "✦", (value) => (iconInput = value))}
        </box>
        <box flexGrow={1}>
          <text fg={theme.text.muted}>{t("Button name")}</text>
          {input(props.skill?.label ?? "", t("e.g. Analyze API"), (value) => (labelInput = value))}
        </box>
      </box>
      <text fg={theme.text.muted}>{t("Instruction to insert into the prompt")}</text>
      {input(
        props.skill?.instruction ?? "",
        t("Write the full instruction here. New lines are supported."),
        (value) => (instructionInput = value),
        8,
      )}
      <box flexDirection="row" gap={2}>
        <text fg={theme.text.base}>
          ctrl+s <span style={{ fg: theme.text.muted }}>{t("save")}</span>
        </text>
        <text fg={theme.text.muted}>{`tab / shift+tab ${t("switch fields")}`}</text>
        <text
          fg={theme.text.muted}
          onMouseUp={(event: MouseEvent) => {
            if (event.button !== 0) return
            event.stopPropagation()
            props.onCancel()
          }}
        >
          {`esc ${t("cancel")}`}
        </text>
      </box>
    </box>
  )
}
