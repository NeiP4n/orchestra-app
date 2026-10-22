import { expect, setDefaultTimeout, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// Bun fails a test after 5 s by default, and every test here boots the whole TUI. A cold module graph
// on the first run costs seconds, so a slow machine failed the short tests and not their assertions.
setDefaultTimeout(30_000)

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_worker",
  title: "Worker task",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const developer = {
  id: "developer",
  agent: "team-developer",
  name: "Developer",
  description: "Implements changes",
  rules: "Role: developer.",
  category: "Build",
  readOnly: false,
  origin: "builtin",
}
const feature = {
  id: "feature",
  name: "Feature",
  description: "Design, build, test and review a new feature",
  origin: "builtin",
  members: [{ agent: "team-developer", title: "Developer", category: "Build" }],
}

type Call = { method: string; path: string; body?: unknown }

function render(
  state: string,
  calls: Call[],
  language?: "ru",
  options: {
    templateFailures?: number
    width?: number
    height?: number
    roles?: Record<string, unknown>[]
    teams?: Record<string, unknown>[]
  } = {},
) {
  const roles: Record<string, unknown>[] = options.roles ?? [developer]
  const teams: Record<string, unknown>[] = options.teams ?? [feature]
  const failures = { templates: options.templateFailures ?? 0 }
  return createAppFixture({
    width: options.width ?? 140,
    height: options.height ?? 44,
    state,
    args: { sessionID: session.id },
    config: { animations: false, language, session: { sidebar: "hide" }, debug: { devtools: true } },
    fetch: async (url, request) => {
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
      if (url.pathname.startsWith("/api/orchestra")) calls.push({ method: request.method, path: url.pathname, body })
      if (url.pathname === "/api/location") return json(location)
      // Room mesh status is unrelated here; report it unavailable like a server without rooms.
      if (url.pathname === "/api/room/mesh")
        return json({ _tag: "ServiceUnavailableError", message: "rooms are off" }, { status: 503 })
      if (url.pathname === "/api/orchestra/project" && request.method === "POST")
        return json({ _tag: "InvalidRequestError", message: "Not an existing directory: /nope", field: "directory" }, { status: 400 })
      if (url.pathname === "/api/orchestra/project") return json([])
      if (url.pathname === "/api/orchestra/role" && request.method === "POST") {
        const role = { ...(body as object), id: "auditor", agent: "team-auditor", origin: "custom" }
        roles.push(role)
        return json(role)
      }
      if (url.pathname === "/api/orchestra/role") return json(roles)
      if (url.pathname === "/api/orchestra/template" && request.method === "POST") {
        const team = { ...(body as object), id: "audit", origin: "custom" }
        teams.push(team)
        return json(team)
      }
      if (url.pathname === "/api/orchestra/template" && failures.templates > 0) {
        failures.templates--
        return new Response("unavailable", { status: 503 })
      }
      if (url.pathname === "/api/orchestra/template") return json(teams)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    },
  })
}

function cell(frame: string, needle: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(needle))
  if (y < 0) throw new Error(`no ${needle} on screen`)
  return { x: lines[y].indexOf(needle), y }
}

// Focus moves one field per tab, so a fixed number of presses breaks as soon as the form gains or
// loses a field. Step the focus and stop on the state the test is about instead: a slow frame then
// costs time, not a different target.
async function tabUntil(
  setup: Awaited<ReturnType<typeof render>>,
  reached: (frame: string) => boolean,
  limit: number,
) {
  for (let presses = 0; presses < limit; presses++) {
    setup.mockInput.pressTab()
    await setup.flush({ maxPasses: 100 })
    const frame = setup.captureCharFrame()
    if (reached(frame)) return frame
  }
  throw new Error(`focus did not reach the expected state in ${limit} tabs:\n${setup.captureCharFrame()}`)
}

test("the team editor creates a role and a team made of it", async () => {
  await using state = await tmpdir()
  const calls: Call[] = []
  await using setup = await render(state.path, calls)

  const bar = await setup.waitForFrame((frame) => frame.includes("Teams") && frame.includes("Experiments"))
  const item = cell(bar, "Teams")
  await setup.mockMouse.click(item.x + 1, item.y)
  await setup.waitForFrame((frame) => frame.includes("Team editor") && frame.includes("Feature"))

  // roles tab, new role: the list's first row, then tab into the form
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("+ New role") && frame.includes("Developer"))
  setup.mockInput.pressKey("n", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Rules"))
  setup.mockInput.typeText("Auditor")
  setup.mockInput.pressTab()
  setup.mockInput.typeText("Quality")
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  // model: the Orchestrator's → fixed → automatic, which asks for the models to pick from
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("models the Orchestrator picks from"))
  setup.mockInput.pressTab()
  setup.mockInput.typeText("test/fast, test/strong")
  setup.mockInput.pressTab()
  // the file access switch
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressTab()
  // tools: only reading files plus an MCP pattern, and the Orchestrator may narrow them
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("□ read") && frame.includes("context7 (AI)"))
  setup.mockInput.pressTab()
  // each tool is its own chip: read, glob and grep are the first three
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressTab()
  setup.mockInput.typeText("context7_*")
  setup.mockInput.pressTab()
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressTab()
  // registry: only the first category
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("mobile"))
  setup.mockInput.pressTab()
  setup.mockInput.pressKey(" ")
  // Registry programs stay "all installed"
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  setup.mockInput.typeText("Check licenses.")
  setup.mockInput.pressKey("s", { ctrl: true })
  await setup.waitFor(() => calls.some((call) => call.method === "POST" && call.path === "/api/orchestra/role"))
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    name: "Auditor",
    category: "Quality",
    description: "",
    rules: "Check licenses.",
    readOnly: true,
    models: ["test/fast", "test/strong"],
    tools: ["read", "glob", "grep", "context7_*"],
    autoTools: true,
    hub: ["build"],
  })
  await setup.waitForFrame((frame) => frame.includes("Auditor") && frame.includes("custom"))

  // teams tab, new team with the new role
  setup.mockInput.pressKey("n", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Rules"))
  // back on the list
  setup.mockInput.pressArrow("left")
  await setup.waitForFrame((frame) => frame.includes("+ New team"))
  setup.mockInput.pressKey("n", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("+ Add member"))
  setup.mockInput.typeText("Audit")
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  // "+ Add member", then the new row's role picker steps to the next role
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("1."))
  setup.mockInput.pressTab()
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("‹ Auditor"))
  // enter opens the role picker; typing filters it and enter picks the match
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Type to filter roles") && frame.includes("Quality · read only"))
  setup.mockInput.typeText("devel")
  await setup.waitForFrame((frame) => !frame.includes("Quality") && frame.includes("Developer"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("‹ Developer") && frame.includes("Playbook"))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("‹ Auditor"))
  setup.mockInput.pressKey("s", { ctrl: true })
  await setup.waitFor(() => calls.some((call) => call.method === "POST" && call.path === "/api/orchestra/template"))
  expect(calls.find((call) => call.path === "/api/orchestra/template" && call.method === "POST")?.body).toEqual({
    name: "Audit",
    description: "",
    members: [{ agent: "team-auditor", title: "", category: "" }],
  })
}, 30_000)

test("the team editor follows the language switch", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, [], "ru")
  const bar = await setup.waitForFrame((frame) => frame.includes("Команды"))
  const item = cell(bar, "Команды")
  await setup.mockMouse.click(item.x + 1, item.y)
  const frame = await setup.waitForFrame((frame) => frame.includes("Редактор команд") && frame.includes("Feature"))
  expect(frame).toContain("+ Новая команда")
  expect(frame).toContain("Участники")
  expect(frame).not.toContain("Members")
})

async function openNewProject(setup: Awaited<ReturnType<typeof render>>, label: string) {
  const bar = await setup.waitForFrame((frame) => frame.includes(label))
  const item = cell(bar, label)
  await setup.mockMouse.click(item.x + 1, item.y)
}

test("the new-project dialog says when teams did not load and retries", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, [], undefined, { templateFailures: 1 })
  await openNewProject(setup, "+ Project")
  const failed = await setup.waitForFrame((frame) => frame.includes("Could not load teams"))
  const retry = cell(failed, "Retry")
  await setup.mockMouse.click(retry.x + 1, retry.y)
  const loaded = await setup.waitForFrame((frame) => frame.includes("Feature") && frame.includes("Developer"))
  expect(loaded).not.toContain("Could not load teams")
})

test("the new-project dialog reads built-in teams and a bad path in Russian", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, [], "ru")
  await openNewProject(setup, "+ Проект")
  const frame = await setup.waitForFrame((frame) => frame.includes("Фича"))
  const lines = frame.split("\n")
  const featureRow = lines.findIndex((line) => line.includes("Фича"))
  expect(featureRow).toBeGreaterThanOrEqual(0)
  // The role description intentionally wraps beneath the team name on a narrow panel.
  expect(lines.slice(featureRow, featureRow + 3).join(" ")).toContain("Разработчик")
  setup.mockInput.pressTab()
  for (let i = 0; i < 80; i++) setup.mockInput.pressBackspace()
  setup.mockInput.typeText("/nope")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Такого каталога нет: /nope"))
})

const builtin = (id: string, name: string, category: string) => ({
  id,
  agent: `team-${id}`,
  name,
  description: `${name} role`,
  rules: `Role: ${name}.`,
  category,
  readOnly: false,
  origin: "builtin",
})

const longRoles = [
  builtin("analyst", "Product Analyst", "Planning"),
  builtin("auditor", "Security Auditor", "Quality"),
  builtin("perf", "Performance Engineer", "Build"),
  builtin("cross", "Cross-platform Engineer", "Build"),
]

async function openRoles(width: number, height: number) {
  const state = await tmpdir()
  const setup = await render(state.path, [], "ru", { roles: longRoles, width, height })
  const bar = await setup.waitForFrame((frame) => frame.includes("Команды"))
  const item = cell(bar, "Команды")
  await setup.mockMouse.click(item.x + 1, item.y)
  await setup.waitForFrame((frame) => frame.includes("Редактор команд"))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("+ Новая роль") && frame.includes("Роли"))
  return { state, setup }
}

const rowOf = (frame: string, label: string) => {
  const line = frame.split("\n").find((line) => line.includes(label))
  if (!line) throw new Error(`no "${label}" row:\n${frame}`)
  return line
}

// The form used to paint its own rows over one another: the switches of Model, Files and Tools
// collapsed onto one line, the actions row ran under the footer, and the list printed the category
// of a role on top of its name. Each row now keeps its own line and the name truncates in its column.
test("the role editor keeps every row on its own line", async () => {
  const { state, setup } = await openRoles(140, 44)
  await using _state = state
  await using _setup = setup
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("+ Новая роль") && frame.includes("Сохранить") && frame.includes("● Все установленные"),
  )

  expect(rowOf(frame, "Модель")).toContain("● Как у оркестратора  ○ Своя  ○ Авто")
  expect(rowOf(frame, "Файлы")).toContain("● Может править  ○ Только чтение")
  expect(rowOf(frame, "Инструменты")).toContain("● Все  ○ Выбранные  □ Оркестратор может сужать")
  expect(rowOf(frame, "Реестр")).toContain("● Все категории  ○ Выбранные")
  expect(rowOf(frame, "Программы")).toContain("● Все установленные  ○ Выбранные")
  // A row painting over its neighbour leaves one of these labels on the wrong line.
  expect(rowOf(frame, "Инструменты")).not.toContain("Только чтение")
  expect(rowOf(frame, "Модель")).not.toContain("Оркестратор может сужать")

  // The list: every category sits in one right-aligned column, preceded by a space, so a long
  // role name truncates inside its own column instead of running into the category.
  const left = rowOf(frame, "+ Новая роль").indexOf("+ Новая роль")
  const columns = frame.split("\n").map((line) => line.slice(left, left + 28))
  const placed = ["Планирование", "Качество", "Build"].flatMap((category) =>
    columns.flatMap((column) => {
      const start = column.indexOf(category)
      if (start < 0) return []
      expect(column[start - 1]).toBe(" ")
      return [start + category.length]
    }),
  )
  expect(placed).toHaveLength(4)
  expect(new Set(placed).size).toBe(1)
})

test("a short terminal keeps the save row and the footer visible", async () => {
  // 30 rows fits the whole form; 24 leaves it taller than the body, so Save and the footer prove
  // they stay pinned below the scrolling fields instead of running past the dialog.
  for (const height of [30, 24]) {
    const { state, setup } = await openRoles(100, height)
    await using _state = state
    await using _setup = setup
    const frame = await setup.waitForFrame(
      (frame) => frame.includes("+ Новая роль") && frame.includes("Сохранить") && frame.includes("↑↓ выбор"),
    )

    // On a narrow terminal the switch rows are the first to run past the form's right edge.
    expect(rowOf(frame, "Файлы")).toContain("● Может править  ○ Только чтение")
    expect(rowOf(frame, "Инструменты")).toContain("● Все  ○ Выбранные  □ Оркестратор может сужать")
    expect(rowOf(frame, "Программы")).toContain("● Все установленные  ○ Выбранные")
    const lines = frame.split("\n")
    const save = lines.findIndex((line) => line.includes("Сохранить"))
    const footer = lines.findIndex((line) =>
      line.includes("↑↓ выбор · ←→ команды/роли · enter править · ctrl+n новая · esc закрыть"),
    )
    expect(save).toBeGreaterThanOrEqual(0)
    expect(footer).toBeGreaterThan(save)
  }
})

// A role that already picks its tools, which is what the operator edits in practice: 33 chips make
// the form taller than a short terminal, so both the row layout and the pinned actions are checked.
const analyst = {
  id: "analyst",
  agent: "team-analyst",
  name: "Product Analyst",
  description: "Turns a request into requirements",
  rules: "Role: product analyst.",
  category: "Planning",
  readOnly: false,
  origin: "custom",
  tools: [
    "read",
    "glob",
    "grep",
    "hub",
    "webfetch",
    "websearch",
    "skill",
    "note",
    "browser",
    "desktop",
    "playtest",
    "idea_bank",
    "plots",
    "context7_*",
    "playwright_*",
    "memory_*",
  ],
  autoTools: true,
}

// Frames are saved for a layout review: TEAM_EDITOR_FRAMES=<dir> bun test test/team-editor.test.tsx
async function saveFrame(name: string, frame: string) {
  const dir = process.env.TEAM_EDITOR_FRAMES
  if (dir) await Bun.write(`${dir}/${name}.txt`, frame)
}

async function openOperatorRole(width: number, height: number) {
  const state = await tmpdir()
  const setup = await render(state.path, [], "ru", {
    roles: [analyst, { ...builtin("perf", "Perf Engineer", "Build"), origin: "custom" }],
    width,
    height,
  })
  const bar = await setup.waitForFrame((frame) => frame.includes("Команды"))
  const item = cell(bar, "Команды")
  await setup.mockMouse.click(item.x + 1, item.y)
  await setup.waitForFrame((frame) => frame.includes("Редактор команд"))
  // The roles tab keeps the cursor on the first role, the custom analyst.
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("+ Новая роль") && frame.includes("Product Analyst"))
  return { state, setup }
}

const footerList = "↑↓ выбор · ←→ команды/роли · enter править · ctrl+n новая · esc закрыть"
const footerForm = "tab следующее поле · ctrl+s сохранить · ctrl+d удалить · esc закрыть"

// The roles list sits left of the form; the form's first field labels its left edge on every row.
function formLeftOf(frame: string) {
  const lines = frame.split("\n")
  const left = lines.find((line) => line.includes("Название"))?.indexOf("Название") ?? -1
  if (left < 0) throw new Error(`no form column:\n${frame}`)
  return left
}

// The app bar names some tabs too, so a field is found by its label column, never by first match.
function formRow(frame: string, label: string) {
  const left = formLeftOf(frame)
  const row = frame.split("\n").find((line) => line.slice(left).startsWith(label))
  if (!row) throw new Error(`no ${label} row:\n${frame}`)
  return row
}

function listColumn(frame: string) {
  const left = formLeftOf(frame)
  return frame.split("\n").map((line) => line.slice(0, left))
}

// Each switch row owns its line: a row painting over its neighbour borrows the neighbour's labels.
function expectOwnRows(frame: string) {
  const lines = frame.split("\n")
  const formLeft = formLeftOf(frame)
  const labels = ["Название", "Категория", "Описание", "Модель", "Файлы", "Инструменты", "Реестр", "Программы", "Правила"]
  // A field row starts with its label in the form's label column.
  const rowFor = (label: string) => lines.find((line) => line.slice(formLeft).startsWith(label))
  // Every label keeps at least one padding cell after it; the old bug glued the next text onto it.
  const glued = labels.filter((label) => !rowFor(label)?.slice(formLeft + label.length).startsWith(" "))
  expect(glued).toEqual([])
  // A collapsed row shows the labels of two fields on one line; no form row may do that. The app bar
  // also names some tabs, so the check covers only rows that start with a field label.
  const rows = lines.filter((line) => labels.some((label) => line.slice(formLeft).startsWith(label)))
  expect(rows.filter((line) => labels.filter((label) => line.includes(label)).length > 1)).toEqual([])

  expect(formRow(frame, "Модель")).toContain("○ Своя  ○ Авто")
  expect(formRow(frame, "Модель")).not.toContain("Оркестратор может сужать")
  expect(formRow(frame, "Файлы")).toContain("● Может править  ○ Только чтение")
  expect(formRow(frame, "Инструменты")).toContain("Оркестратор может сужать")
  expect(formRow(frame, "Инструменты")).not.toContain("Только чтение")
  expect(formRow(frame, "Реестр")).toContain("● Все категории  ○ Выбранные")
  expect(formRow(frame, "Реестр")).not.toContain("Все установленные")
  expect(formRow(frame, "Программы")).toContain("● Все установленные  ○ Выбранные")
  expect(formRow(frame, "Программы")).not.toContain("Все категории")
  // The file access row is the only place that offers the switch, and its label sits in the column.
  const access = lines.filter((line) => line.includes("Может править"))
  expect(access).toHaveLength(1)
  expect(access[0]!.indexOf("Файлы")).toBeLessThan(access[0]!.indexOf("Может править"))
}

test("a role with picked tools keeps the fields, the save row and the footer apart", async () => {
  const { state, setup } = await openOperatorRole(140, 44)
  await using _state = state
  await using _setup = setup
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("● Выбранные") && frame.includes("■ read") && frame.includes("Сохранить"),
  )
  await saveFrame("verify-custom-tools-140x44", frame)

  expectOwnRows(frame)
  // The chip block is the tall part of the form: many rows of tools, none of them clipped by the width.
  const chips = frame.split("\n").filter((line) => line.includes("□") || line.includes("■"))
  expect(chips.length).toBeGreaterThanOrEqual(4)
  expect(frame).toContain("■ read")
  expect(frame).toContain("□ shell")
  // The last chip of the catalog still renders whole, so no row lost its tail to the terminal edge.
  expect(frame).toContain("□ mcp-docs (AI)")
  expect(frame.split("\n").filter((line) => Bun.stringWidth(line) > 140)).toHaveLength(0)

  const lines = frame.split("\n")
  const save = lines.findIndex((line) => line.includes("Сохранить"))
  const footer = lines.findIndex((line) => line.includes(footerList))
  expect(save).toBeGreaterThanOrEqual(0)
  // The footer is the last row of the dialog and nothing paints over it.
  expect(footer).toBeGreaterThan(save)
  expect(lines.filter((line) => line.includes(footerList))).toHaveLength(1)

  // The list: the category column starts after a space and does not run into the role name.
  const list = listColumn(frame)
  const planning = list.find((line) => line.includes("Planning"))
  const build = list.find((line) => line.includes("Build"))
  if (!planning || !build) throw new Error(`no category rows:\n${frame}`)
  const category = planning.indexOf("Planning") + "Planning".length
  // The same right edge in both rows, and a space before the category in each.
  expect(build.indexOf("Build") + "Build".length).toBe(category)
  expect({ planning: planning[planning.indexOf("Planning") - 1], build: build[build.indexOf("Build") - 1] }).toEqual({
    planning: " ",
    build: " ",
  })
  expect(planning.slice(0, planning.indexOf("Planning")).trim().length).toBeGreaterThan(0)
}, 30_000)

test("picked tools scroll under the pinned actions on a narrow terminal", async () => {
  for (const height of [30, 24]) {
    const { state, setup } = await openOperatorRole(100, height)
    await using _state = state
    await using _setup = setup
    const before = await setup.waitForFrame(
      (frame) => frame.includes("● Выбранные") && frame.includes("Сохранить") && frame.includes(footerList),
    )
    await saveFrame(`verify-custom-tools-100x${height}-before`, before)
    const beforeLines = before.split("\n")
    const saveAt = beforeLines.findIndex((line) => line.includes("Сохранить"))
    const footerAt = beforeLines.findIndex((line) => line.includes(footerList))
    // The visible top of the form keeps its rows apart on the narrow width too.
    expect(rowOf(before, "Файлы")).toContain("● Может править  ○ Только чтение")
    expect(rowOf(before, "Инструменты")).toContain("Оркестратор может сужать")
    expect(rowOf(before, "Инструменты")).not.toContain("Только чтение")
    expect(beforeLines.filter((line) => line.includes("Может править"))).toHaveLength(1)
    expect(beforeLines.filter((line) => Bun.stringWidth(line) > 100)).toHaveLength(0)
    expect(saveAt).toBeGreaterThanOrEqual(0)
    expect(footerAt).toBeGreaterThan(saveAt)

    // The rules sit below the fold before focus enters the form, so only tabbing can bring them in.
    expect(before).not.toContain("Правила")
    // tab walks the form to the rules: the body scrolls under the actions.
    const after = await tabUntil(
      setup,
      (frame) => frame.includes("Правила") && frame.includes("Role: product analyst.") && frame.includes(footerForm),
      40,
    )
    await saveFrame(`verify-custom-tools-100x${height}-after`, after)
    const afterLines = after.split("\n")
    expect(after).not.toBe(before)
    // The rows the scroll brought in keep one field per line as well.
    expect(rowOf(after, "Реестр")).toContain("● Все категории  ○ Выбранные")
    expect(rowOf(after, "Реестр")).not.toContain("Все установленные")
    expect(rowOf(after, "Программы")).toContain("● Все установленные  ○ Выбранные")
    expect(rowOf(after, "Программы")).not.toContain("Все категории")
    // The rules row came into view, including the text the textarea holds.
    expect(rowOf(after, "Правила")).toContain("Role: product analyst.")
    // The actions and the footer did not move while the fields scrolled.
    expect(afterLines.findIndex((line) => line.includes("Сохранить"))).toBe(saveAt)
    expect(afterLines.findIndex((line) => line.includes(footerForm))).toBe(footerAt)
    expect(afterLines.filter((line) => Bun.stringWidth(line) > 100)).toHaveLength(0)
  }
}, 60_000)

// A switch has no input of its own, so focus used to land on it without scrolling: the row stayed
// below the fold while ←→ or space flipped a setting nobody could see. Focus now scrolls its own
// row in, so the row that just scrolled in is the one the arrow key changes.
test("a switch row below the fold scrolls in when focus reaches it", async () => {
  const { state, setup } = await openOperatorRole(100, 24)
  await using _state = state
  await using _setup = setup
  const open = await setup.waitForFrame((frame) => frame.includes("● Выбранные") && frame.includes("Сохранить"))
  // "Реестр" alone also names the app bar tab, so a row is found by its label and its switch.
  const row = (frame: string, label: string, text: string) =>
    frame.split("\n").find((line) => line.includes(label) && line.includes(text))

  // The form starts at its top: the Registry switch sits below the fold.
  expect(row(open, "Реестр", "Все категории")).toBeUndefined()

  const after = await tabUntil(setup, (frame) => row(frame, "Реестр", "Все категории") !== undefined, 40)
  await saveFrame("verify-switch-scroll-100x24", after)
  // The scroll came from the focused switch itself and not from the tail of the form: the rows
  // after it are still below the fold.
  expect(after.split("\n").filter((line) => line.trimStart().startsWith("Правила"))).toHaveLength(0)
  // The focus is on that row: → flips it, and the flip shows on the row that just scrolled in.
  setup.mockInput.pressArrow("right")
  const flipped = await setup.waitForFrame((frame) => {
    const line = row(frame, "Реестр", "Выбранные")
    return line !== undefined && line.includes("○ Все категории") && line.includes("● Выбранные")
  })
  expect(row(flipped, "Реестр", "Все категории")).toBeDefined()
}, 30_000)

// The member block is a scrollbox of its own inside the form's scrollbox, so the form staying
// still was not enough: tabbing to the last member used to focus a row nobody could see.
test("tab reaches the last member of a long team", async () => {
  const members = Array.from({ length: 8 }, (_, index) => ({
    agent: "team-developer",
    title: `Developer ${index + 1}`,
    category: "Build",
  }))
  for (const [width, height] of [
    [140, 44],
    [100, 24],
  ] as const) {
    await using state = await tmpdir()
    await using setup = await render(state.path, [], undefined, {
      teams: [{ id: "squad", name: "Squad", description: "Eight members", origin: "custom", members }],
      width: 140,
      height: 44,
    })
    const bar = await setup.waitForFrame((frame) => frame.includes("Teams"))
    const item = cell(bar, "Teams")
    await setup.mockMouse.click(item.x + 1, item.y)
    await setup.waitForFrame((frame) => frame.includes("Team editor") && frame.includes("Squad"))
    // Open where the bar is known to fit, then narrow to the size under test.
    if (width !== 140 || height !== 44) {
      setup.resize(width, height)
      await setup.flush({ maxPasses: 100 })
    }
    const open = setup.captureCharFrame()
    const lastMember = (frame: string) =>
      frame.split("\n").some((line) => line.includes("8.") && line.includes("Developer"))

    // Six rows of the member block are visible; the eighth row is below its fold.
    expect(lastMember(open)).toBe(false)
    await saveFrame(`verify-last-member-${width}x${height}-before`, open)

    // Two fields, then title/role/category of each of the eight members. Step the focus until the
    // eighth row shows instead of counting tabs, so a new field cannot silently change the target.
    const after = await tabUntil(setup, lastMember, 60)
    await saveFrame(`verify-last-member-${width}x${height}-after`, after)
    expect(lastMember(after)).toBe(true)
    // The member list scrolled; the pinned actions and the form did not move away.
    expect(after).toContain("Save")
  }
}, 60_000)
