export * as DodKanban from "./dod-kanban.js"

import { Effect } from "effect"
import type { Room } from "@orchestra/schema/room"
import { Dod } from "./dod.js"
import { Zones } from "./zones.js"

// The kanban board over the room's DoD: the same items grouped into columns by
// state, with who holds each card and whether the viewer may take it. A guest
// sees its own cards marked and foreign zones read-only; the host sees all.
// The board never offers a card the take would refuse: canTake mirrors
// Dod.mayClaim, so a card shown as takeable is one the viewer can actually take.

// The columns, in board order, over the file's task_state values. An unknown
// state is work that never started, so it lands in "to do" with its state kept
// on the card.
const COLUMNS = [
  { id: "todo", title: "To do", states: ["NOT_STARTED"] },
  { id: "in_progress", title: "In progress", states: ["IN_PROGRESS"] },
  { id: "blocked", title: "Blocked", states: ["BLOCKED"] },
  { id: "failed", title: "Failed", states: ["FAILED"] },
  { id: "done", title: "Done", states: ["DONE", "OUT_OF_SCOPE"] },
] as const
type ColumnID = (typeof COLUMNS)[number]["id"]

const FINISHED = new Set(["DONE", "OUT_OF_SCOPE"])

function columnOf(state: string): ColumnID {
  return COLUMNS.find((column) => column.states.some((candidate) => candidate === state))?.id ?? "todo"
}

/** Who reads the board: the host operator, or a room guest (member). */
export type Viewer =
  | { readonly type: "host" }
  | { readonly type: "guest"; readonly id: string; readonly name: string; readonly group?: string }

/** Builds the board from the DoD items and the zone registry, for one viewer. */
export function buildBoard(input: {
  items: readonly Room.DodItem[]
  zones: Zones.Registry
  viewer: Viewer
  status?: "ready" | "disabled"
}): Room.DodBoard {
  const owner = input.viewer.type === "guest" ? { id: input.viewer.id, name: input.viewer.name } : undefined
  const group = input.viewer.type === "guest" ? input.viewer.group : undefined
  const cards = input.items.map((item): Room.DodBoardCard => {
    const zone = Zones.zoneOf(input.zones, item.stage)
    const foreign = zone !== undefined && Zones.isCrossZone(input.zones, item.stage, group)
    const hasPass =
      group !== undefined && zone !== undefined && Zones.passFor(input.zones, zone.name, group) !== undefined
    // A stale claim in a foreign zone is the automatic pass, so the card is not
    // read-only even without an explicit pass.
    const readOnly = foreign && !hasPass && item.stale !== true
    const refusal =
      owner === undefined
        ? "Only guests take items; the host frees them"
        : Dod.mayClaim(item, owner, input.items, { group, zones: input.zones })
    return {
      id: item.id,
      what: item.what,
      stage: item.stage,
      state: item.state,
      done: item.done,
      total: item.total,
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.ownerID ? { ownerID: item.ownerID } : {}),
      mine: owner !== undefined && item.ownerID === owner.id,
      ...(item.stale ? { stale: item.stale } : {}),
      ...(item.waits ? { waits: item.waits } : {}),
      ...(item.verify ? { verify: item.verify } : {}),
      ...(zone ? { zone: zone.name, zoneOwner: zone.owner_group } : {}),
      hasPass,
      canTake: refusal === undefined,
      ...(refusal ? { takeRefusal: refusal } : {}),
      readOnly,
    }
  })
  const columns: Room.DodBoardColumn[] = COLUMNS.map((column) => ({
    id: column.id,
    title: column.title,
    cards: cards.filter((card) => columnOf(card.state) === column.id),
  }))
  return {
    ...(input.status ? { status: input.status } : {}),
    columns,
    zones: input.zones.zones.map((zone) => ({
      name: zone.name,
      ownerGroup: zone.owner_group,
      mine: group !== undefined && zone.owner_group === group,
    })),
    counts: {
      total: cards.length,
      done: cards.filter((card) => FINISHED.has(card.state)).length,
      inProgress: cards.filter((card) => card.state === "IN_PROGRESS").length,
      blocked: cards.filter((card) => card.state === "BLOCKED").length,
      failed: cards.filter((card) => card.state === "FAILED").length,
      free: cards.filter((card) => !FINISHED.has(card.state) && (!card.ownerID || card.stale) && !card.waits).length,
    },
  }
}

/** Reads the board and the zone registry and builds the board for one viewer. */
export const board = Effect.fn("DodKanban.board")(function* (input: {
  directory: string
  viewer: Viewer
  live?: Dod.Live
}) {
  const dod = yield* Dod.read(input.directory, input.live)
  const zones = yield* Zones.load(input.directory)
  return buildBoard({ items: dod.items, zones, viewer: input.viewer, status: dod.status })
})
