import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Dod } from "@orchestra/core/dod"
import { DodKanban } from "@orchestra/core/dod-kanban"
import { Zones } from "@orchestra/core/zones"
import type { Room } from "@orchestra/schema/room"
import { tmpdir } from "./fixture/tmpdir"

const FILE = `task_id: T-KANBAN
stages: []
leaves:
  - id: L-001
    what: "Free task"
    group: "Team A"
    task_state: NOT_STARTED
    steps:
      - "[ ] first step"
      - "[ ] second step"

  - id: L-002
    what: "Work in hand"
    group: "Team A"
    task_state: IN_PROGRESS
    owner: "Alex"
    owner_id: "g-alex"
    steps:
      - "[x] done step"
      - "[ ] open step"

  - id: L-003
    what: "Stuck task"
    group: "Team A"
    task_state: BLOCKED
    owner: "Bo"
    owner_id: "g-bo"

  - id: L-004
    what: "Failed check"
    group: "Team B"
    task_state: FAILED

  - id: L-005
    what: "Finished task"
    group: "Team B"
    task_state: DONE

  - id: L-006
    what: "Dropped task"
    group: "Team B"
    task_state: OUT_OF_SCOPE

  - id: L-007
    what: "Waits for the free task"
    group: "Team A"
    task_state: NOT_STARTED
    depends_on: [L-001]
`

const ZONES = `zones:
  - name: "Team A"
    owner_group: "team-a"
  - name: "Team B"
    owner_group: "team-b"
passes: []
`

const ZONES_WITH_PASS = `zones:
  - name: "Team A"
    owner_group: "team-a"
  - name: "Team B"
    owner_group: "team-b"
passes:
  - zone: "Team A"
    group: "team-b"
    granted_at: "2026-11-06T00:00:00.000Z"
    granted_by: "Alex"
`

async function project(text = FILE, zones = ZONES) {
  const dir = await tmpdir()
  await mkdir(path.join(dir.path, ".orchestra"), { recursive: true })
  await Bun.write(path.join(dir.path, Dod.FILE), text)
  await Bun.write(path.join(dir.path, Zones.FILE), zones)
  return dir
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const alex = { id: "g-alex", name: "Alex" }
const bo = { id: "g-bo", name: "Bo" }
const guestA: DodKanban.Viewer = { type: "guest", ...alex, group: "team-a" }
const guestB: DodKanban.Viewer = { type: "guest", ...bo, group: "team-b" }
const host: DodKanban.Viewer = { type: "host" }

const boardOf = (dir: string, viewer: DodKanban.Viewer) =>
  run(DodKanban.board({ directory: dir, viewer, live: () => true }))

const card = (board: Room.DodBoard, id: string) =>
  board.columns.flatMap((column) => column.cards).find((entry) => entry.id === id)!

describe("DodKanban", () => {
  test("groups items into columns by state", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    const byId = new Map(board.columns.map((column) => [column.id, column.cards.map((entry) => entry.id)]))
    expect(byId.get("todo")).toEqual(["L-001", "L-007"])
    expect(byId.get("in_progress")).toEqual(["L-002"])
    expect(byId.get("blocked")).toEqual(["L-003"])
    expect(byId.get("failed")).toEqual(["L-004"])
    expect(byId.get("done")).toEqual(["L-005", "L-006"])
    expect(board.status).toBe("ready")
  })

  test("an unknown state lands in to do with its state kept", async () => {
    await using dir = await project(
      FILE.replace('task_state: NOT_STARTED', 'task_state: REVIEWING'),
    )
    const board = await boardOf(dir.path, guestA)
    const todo = board.columns.find((column) => column.id === "todo")!
    expect(todo.cards.map((entry) => entry.id)).toContain("L-001")
    expect(todo.cards.find((entry) => entry.id === "L-001")!.state).toBe("REVIEWING")
  })

  test("shows who holds each card and marks the viewer's own", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    const held = card(board, "L-002")
    expect(held.owner).toBe("Alex")
    expect(held.ownerID).toBe("g-alex")
    expect(held.mine).toBe(true)
    expect(held.canTake).toBe(true)
    expect(card(board, "L-003").mine).toBe(false)
    expect(card(board, "L-003").owner).toBe("Bo")
  })

  test("a card taken by someone else cannot be taken, with the holder named", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestB)
    const held = card(board, "L-002")
    expect(held.canTake).toBe(false)
    expect(held.takeRefusal).toContain("taken by Alex")
  })

  test("a card waiting on unfinished work cannot be taken", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    const waiting = card(board, "L-007")
    expect(waiting.canTake).toBe(false)
    expect(waiting.takeRefusal).toContain("waits for L-001")
  })

  test("a finished card cannot be taken", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    expect(card(board, "L-005").canTake).toBe(false)
    expect(card(board, "L-005").takeRefusal).toContain("already done")
  })

  test("a foreign zone is read-only without a pass", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestB)
    const foreign = card(board, "L-001")
    expect(foreign.zone).toBe("Team A")
    expect(foreign.zoneOwner).toBe("team-a")
    expect(foreign.hasPass).toBe(false)
    expect(foreign.readOnly).toBe(true)
    expect(foreign.canTake).toBe(false)
    expect(foreign.takeRefusal).toContain("zone")
  })

  test("an explicit pass lets the other group take the card", async () => {
    await using dir = await project(FILE, ZONES_WITH_PASS)
    const board = await boardOf(dir.path, guestB)
    const passed = card(board, "L-001")
    expect(passed.hasPass).toBe(true)
    expect(passed.readOnly).toBe(false)
    expect(passed.canTake).toBe(true)
  })

  test("a stale claim in a foreign zone is the automatic pass", async () => {
    await using dir = await project()
    const board = await run(
      DodKanban.board({ directory: dir.path, viewer: guestB, live: (id) => id !== "g-alex" }),
    )
    const stalled = card(board, "L-002")
    expect(stalled.stale).toBe(true)
    expect(stalled.readOnly).toBe(false)
    expect(stalled.canTake).toBe(true)
  })

  test("the WIP limit blocks a fourth card in the same stage", async () => {
    const wip = `task_id: T-WIP
stages: []
leaves:
  - id: L-001
    what: "First in work"
    group: "Team A"
    task_state: IN_PROGRESS
    owner: "Alex"
    owner_id: "g-alex"
  - id: L-002
    what: "Second in work"
    group: "Team A"
    task_state: IN_PROGRESS
    owner: "Bo"
    owner_id: "g-bo"
  - id: L-003
    what: "Third in work"
    group: "Team A"
    task_state: BLOCKED
    owner: "Cy"
    owner_id: "g-cy"
  - id: L-004
    what: "Fourth waits"
    group: "Team A"
    task_state: NOT_STARTED
`
    await using dir = await project(wip)
    const board = await boardOf(dir.path, guestA)
    const fourth = card(board, "L-004")
    expect(fourth.canTake).toBe(false)
    expect(fourth.takeRefusal).toContain("already has 3 tasks in work")
  })

  test("the host sees everything and takes nothing", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, host)
    expect(board.columns.flatMap((column) => column.cards).every((entry) => entry.mine === false)).toBe(true)
    expect(board.columns.flatMap((column) => column.cards).every((entry) => entry.canTake === false)).toBe(true)
    expect(card(board, "L-001").takeRefusal).toContain("the host frees them")
    expect(card(board, "L-002").owner).toBe("Alex")
  })

  test("counts the board", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    expect(board.counts).toEqual({ total: 7, done: 2, inProgress: 1, blocked: 1, failed: 1, free: 2 })
  })

  test("a card marked for a human is never takeable by a guest, and never counts as free for one", async () => {
    const human = `task_id: T-HUMAN
stages: []
leaves:
  - id: H-001
    what: "Human decision"
    group: "Team A"
    task_state: NOT_STARTED
    human: true
  - id: L-001
    what: "Free task"
    group: "Team A"
    task_state: NOT_STARTED
`
    await using dir = await project(human)
    const guestBoard = await boardOf(dir.path, guestA)
    const humanCard = card(guestBoard, "H-001")
    expect(humanCard.human).toBe(true)
    expect(humanCard.canTake).toBe(false)
    expect(humanCard.takeRefusal).toContain("marked for a human")
    expect(guestBoard.counts.free).toBe(1)
    // The host works it by hand, so on the host board it still counts as free.
    const hostBoard = await boardOf(dir.path, host)
    expect(card(hostBoard, "H-001").human).toBe(true)
    expect(hostBoard.counts.free).toBe(2)
  })

  test("lists the zones and marks the viewer's own", async () => {
    await using dir = await project()
    const board = await boardOf(dir.path, guestA)
    expect(board.zones).toEqual([
      { name: "Team A", ownerGroup: "team-a", mine: true },
      { name: "Team B", ownerGroup: "team-b", mine: false },
    ])
  })

  test("a project without a DoD has a disabled, empty board", async () => {
    const dir = await tmpdir()
    const board = await boardOf(dir.path, guestA)
    expect(board.status).toBe("disabled")
    expect(board.columns.flatMap((column) => column.cards)).toEqual([])
    expect(board.counts.total).toBe(0)
  })

  test("a project without zones has no restrictions", async () => {
    const dir = await tmpdir()
    await mkdir(path.join(dir.path, ".orchestra"), { recursive: true })
    await Bun.write(path.join(dir.path, Dod.FILE), FILE)
    const board = await boardOf(dir.path, guestB)
    expect(card(board, "L-001").readOnly).toBe(false)
    expect(card(board, "L-001").canTake).toBe(true)
    expect(board.zones).toEqual([])
  })
})
