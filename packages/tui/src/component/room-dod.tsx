import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { RoomDod, RoomDodBoard, RoomDodItem, RoomEvent, RoomFeed } from "@orchestra/client/promise"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { useT } from "../util/i18n"
import { Row } from "./panel-row"
import { hoverForeground } from "../ui/hover"
import { HoverAction } from "./hover-action"

const FINISHED = new Set(["DONE", "OUT_OF_SCOPE"])
const MARK: Record<string, string> = { DONE: "✓", IN_PROGRESS: "●", BLOCKED: "!", FAILED: "✗", OUT_OF_SCOPE: "–" }
const BAR = 8
// How many of the room's latest events show under the DoD.
const FEED_SHOWN = 5
// An empty feed answer waits this long on the host for the next event.
const FEED_WAIT_MS = 20_000
const FEED_RETRY_MS = 5_000
// An empty feed answered faster than this did not wait for events.
const FEED_IMMEDIATE_MS = 1_000

type PanelState =
  | { type: "starting" }
  | { type: "ready" }
  | { type: "disabled" }
  | { type: "stale"; reason: string }
  | { type: "connection-error"; reason: string }
  | { type: "unknown"; reason: string }

// The shared project's Definition of Done under a room in the Multiplayer panel: the
// room's work queue, with who took each open item. A guest takes a free item or the next
// ready one, submits its own to the host's check and gives it back; the host frees an item
// a guest left behind. Finished items only count toward the bar, so a long DoD stays a
// short list. The room's latest events follow, and each one reloads the list at once.
// A project without a DoD shows nothing.
//
// With loadBoard, the panel also offers the kanban board: the same items grouped into
// columns by state, with who holds each card and whether the viewer may take it. Cards
// in a foreign zone are read-only without a pass, and a card the take would refuse is
// shown with its reason instead of a take action. The board follows the same reloads
// as the list (feed events and the 5 s poll).
export function RoomDodRows(props: {
  id: string
  load: () => Promise<RoomDod>
  // The kanban board for the same room; absent, the panel stays a list.
  loadBoard?: () => Promise<RoomDodBoard>
  // Guests only; absent on the host, which frees instead of taking. Without an item, takes the next ready one.
  take?: (item?: string) => Promise<RoomDod>
  submit?: (item: string) => Promise<RoomDod>
  release: (item: string) => Promise<RoomDod>
  feed: (after: number, wait: number) => Promise<RoomFeed>
  hover: () => string | undefined
  setHover: (id: string | undefined) => void
  // Columns before the arrow: the left panel nests the DoD under its room, a sidebar does not.
  indent?: number
  open?: boolean
  // Said quietly when the project has no DoD; without it such a project shows nothing.
  disabledNote?: string
}) {
  const theme = useTheme()
  const toast = useToast()
  const t = useT()
  const [items, setItems] = createSignal<readonly RoomDodItem[]>([])
  const [board, setBoard] = createSignal<RoomDodBoard>()
  const [view, setView] = createSignal<"list" | "board">("list")
  const [open, setOpen] = createSignal(props.open ?? false)
  const indent = () => props.indent ?? 4
  const [armed, setArmed] = createSignal<string>()
  const [nextHovered, setNextHovered] = createSignal(false)
  const [boardHovered, setBoardHovered] = createSignal(false)
  const [events, setEvents] = createSignal<readonly RoomEvent[]>([])
  const [status, setStatus] = createSignal<PanelState>({ type: "starting" })
  // Retain the last usable payload after a failed refresh, but never mark it as current.
  const [loadedAt, setLoadedAt] = createSignal<number>()
  let generation = 0
  const read = () => {
    const request = ++generation
    const projectID = props.id
    if (loadedAt() === undefined) setStatus({ type: "starting" })
    void Promise.resolve()
      .then(() => props.load())
      .then((dod) => {
        // A late response from the previous room/project must not overwrite the selected one.
        if (request !== generation || projectID !== props.id) return
        if (!dod || !Array.isArray(dod.items)) {
          setStatus({ type: "unknown", reason: "The service returned an invalid DoD response." })
          return
        }
        setItems(dod.items)
        setLoadedAt(Date.now())
        if (dod.status === "disabled") {
          setItems([])
          setBoard(undefined)
          setStatus({ type: "disabled" })
          return
        }
        if (dod.status === "ready") {
          setStatus({ type: "ready" })
          return
        }
        // An older server may return items without a status. The data can be shown, but
        // the service state is unknown and must not be promoted to READY. The reason
        // stays short enough for the board's one-line status row to show it in full.
        setStatus({
          type: "unknown",
          reason: "The response omitted the explicit service state.",
        })
      })
      .catch((error: unknown) => {
        if (request !== generation || projectID !== props.id) return
        const reason = errorMessage(error)
        if (loadedAt() !== undefined) {
          setStatus({ type: "stale", reason })
        } else if (/service did not answer|state unknown|unknown state/i.test(reason)) {
          setStatus({ type: "unknown", reason })
        } else {
          setStatus({ type: "connection-error", reason })
        }
      })
    // The board follows the same reloads as the list; a failed board load never
    // breaks the list, it only hides the board view until the next reload.
    if (props.loadBoard) {
      void Promise.resolve()
        .then(() => props.loadBoard!())
        .then((loaded) => {
          if (request !== generation || projectID !== props.id) return
          if (loaded && Array.isArray(loaded.columns)) setBoard(loaded)
        })
        .catch(() => undefined)
    }
  }

  createEffect(
    on(
      () => props.id,
      () => {
        generation++
        setItems([])
        setBoard(undefined)
        setEvents([])
        setLoadedAt(undefined)
        setStatus({ type: "starting" })
        read()
      },
      { defer: false },
    ),
  )

  const statusText = () => {
    const current = status()
    // DoD is optional; a project without one is not a problem to warn every guest about.
    if (current.type === "disabled") return props.disabledNote
    if (current.type === "ready") return
    if (current.type === "starting") return t("DoD service is starting or checking the active project…")
    if (current.type === "stale")
      return t("DoD response is stale; last response at {time}. Refresh failed: {reason}", {
        time: loadedAt() === undefined ? "unknown" : new Date(loadedAt()!).toLocaleTimeString(),
        reason: current.reason,
      })
    if (current.type === "connection-error") return t("DoD connection error: {reason}", { reason: current.reason })
    return t("DoD state unknown: {reason}", { reason: current.reason })
  }
  const showBoard = () =>
    status().type === "ready" || (items().length > 0 && ["stale", "unknown"].includes(status().type))

  onMount(() => {
    // Leases run out without an event, so the list still refreshes now and then.
    const timer = setInterval(read, 5000)
    const state = { alive: true, after: 0 }
    onCleanup(() => {
      clearInterval(timer)
      state.alive = false
      generation++
    })
    const follow = async () => {
      while (state.alive) {
        const asked = Date.now()
        // A custom fetch or adapter may throw before it returns its Promise.
        const feed = await Promise.resolve()
          .then(() => props.feed(state.after, FEED_WAIT_MS))
          .catch(() => undefined)
        if (!state.alive) return
        if (!feed) {
          await Bun.sleep(FEED_RETRY_MS)
          continue
        }
        if (feed.events.length === 0) {
          // A host long-polls and answers empty when its wait runs out; asking again at once keeps
          // the next event instant. Only an adapter that answers empty without waiting backs off.
          if (Date.now() - asked < FEED_IMMEDIATE_MS) await Bun.sleep(FEED_RETRY_MS)
          continue
        }
        // A host that restarted numbers its events anew, so its feed replaces what was shown.
        const fresh = feed.events[0].seq <= state.after
        state.after = feed.events.at(-1)!.seq
        setEvents((shown) => [...(fresh ? [] : shown), ...feed.events].slice(-FEED_SHOWN))
        read()
      }
    }
    void follow()
  })
  const act = (action: () => Promise<RoomDod>, done?: (dod: RoomDod) => void) =>
    void action()
      .then((dod) => {
        setItems(dod.items)
        // The board's canTake and owners change with the take, so it reloads too.
        read()
        done?.(dod)
      })
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  const submitted = (item: string) => (dod: RoomDod) =>
    toast.show({
      message:
        dod.check?.exitCode === 0
          ? t("{item} passed the host's check", { item })
          : t("{item} failed the host's check (exit code {code})", { item, code: dod.check?.exitCode ?? "?" }),
      variant: dod.check?.exitCode === 0 ? "success" : "error",
    })
  const verb = (event: RoomEvent) => t(VERB[event.kind])

  const finished = () => items().filter((item) => FINISHED.has(item.state)).length
  const remaining = () => items().filter((item) => !FINISHED.has(item.state))
  const taken = () => items().filter((item) => item.owner && !item.stale && !FINISHED.has(item.state)).length
  const ready = () => items().some((item) => !FINISHED.has(item.state) && (!item.owner || item.stale) && !item.waits)
  const bar = () => {
    const filled = items().length === 0 ? 0 : Math.round((finished() / items().length) * BAR)
    return "█".repeat(filled) + "░".repeat(BAR - filled)
  }
  const color = (state: string) =>
    state === "DONE"
      ? theme.text.feedback.success.base
      : state === "IN_PROGRESS"
        ? theme.text.feedback.info.base
        : state === "BLOCKED"
          ? theme.text.feedback.warning.base
          : state === "FAILED"
            ? theme.text.feedback.error.base
            : theme.text.muted
  const actionId = (item: { id: string }) => `${props.id}:dod:${item.id}`

  // compact: composed as one truncated line in the board's own row style (every other
  // row of the panel is a single truncated line); the standalone form wraps in full.
  const StatusBox = (boxProps: { pad: number; compact?: boolean }) => (
    <Show when={statusText()}>
      {(message) => (
        <box paddingLeft={boxProps.pad} paddingRight={1}>
          <text
            fg={
              status().type === "starting" || status().type === "disabled"
                ? theme.text.muted
                : theme.text.feedback.error.base
            }
            wrapMode={boxProps.compact ? "none" : "word"}
            truncate={boxProps.compact}
          >
            {message()}
          </text>
        </box>
      )}
    </Show>
  )

  return (
    <>
      {/* Without a board there is no DoD row to attach the state to, so it stands alone.
          With a board, the state belongs UNDER the DoD header row (rendered inside
          showBoard below): above the header it reads as an error of the room section
          that hosts this component, not of the DoD. */}
      <Show when={!showBoard()}>
        <StatusBox pad={indent() + 1} />
      </Show>
      <Show when={showBoard()}>
        <Row id={`${props.id}:dod`} hover={props.hover} setHover={props.setHover} onClick={() => setOpen(!open())}>
          <text flexShrink={0} fg={theme.text.muted}>
            {`${" ".repeat(indent())}${open() ? "▾" : "▸"} `}
          </text>
          <box flexGrow={1} minWidth={0} flexDirection="row">
            <text fg={theme.text.base} wrapMode="none" flexShrink={0}>
              {t("DoD")}
              <span style={{ fg: theme.text.muted }}>
                {` ${finished()}/${items().length}`}
                {taken() > 0 ? ` · ${t("{count} taken", { count: taken() })}` : ""}
              </span>
            </text>
            {/* Only the decorative bar may shrink. Middle truncation of a
                combined label hid the ownership count on narrow panels. */}
            <text fg={theme.text.feedback.success.base} wrapMode="none" flexShrink={1} minWidth={0} truncate>{` ${bar()}`}</text>
          </box>
          <Show when={props.take && ready()}>
            <HoverAction
              id={`${props.id}:dod:next`}
              onMouseEnter={() => props.setHover(`${props.id}:dod`)}
              onMouseLeave={() => props.setHover(`${props.id}:dod`)}
              onHoverChange={setNextHovered}
              onClick={() =>
                act(
                  () => props.take!(),
                  (dod) =>
                    dod.taken && toast.show({ message: t("{item} is yours", { item: dod.taken }), variant: "info" }),
                )
              }
            >
              <text fg={nextHovered() ? theme.text.base : theme.text.action.primary.base}>{` ${t("next")}`}</text>
            </HoverAction>
          </Show>
          <Show when={props.loadBoard && board()}>
            <HoverAction
              id={`${props.id}:dod:view`}
              onHoverChange={setBoardHovered}
              onClick={() => setView(view() === "board" ? "list" : "board")}
            >
              <text fg={boardHovered() ? theme.text.base : theme.text.action.primary.base}>
                {` ${view() === "board" ? t("list") : t("board")}`}
              </text>
            </HoverAction>
          </Show>
        </Row>
        <StatusBox pad={indent() + 3} compact />
        <Show when={open()}>
          <Show when={view() === "board" && board()}>
            {(loaded) => (
              <>
                <Show when={loaded().zones.length > 0}>
                  <box paddingLeft={indent() + 3} paddingRight={1}>
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      {`${t("Zones")}: ${loaded()
                        .zones.map((zone) => `${zone.name}${zone.mine ? ` (${t("yours")})` : ""}`)
                        .join(" · ")}`}
                    </text>
                  </box>
                </Show>
                <box flexDirection="row" paddingLeft={indent() + 3} paddingRight={1}>
                  <For each={loaded().columns}>
                    {(column) => (
                      <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} paddingRight={1}>
                        <text fg={theme.text.muted} wrapMode="none" truncate>
                          {`${column.title} (${column.cards.length})`}
                        </text>
                        <For each={column.cards}>
                          {(card) => (
                            <box flexDirection="column">
                              <box flexDirection="row">
                                <text flexShrink={0} fg={color(card.state)}>
                                  {`${MARK[card.state] ?? "·"} `}
                                </text>
                                <box flexGrow={1} minWidth={0}>
                                  <text fg={theme.text.base} wrapMode="none" truncate>
                                    <span style={{ fg: theme.text.muted }}>{`${card.id} `}</span>
                                    {card.what || card.id}
                                    <span style={{ fg: theme.text.muted }}>
                                      {Number(card.total) > 0 ? ` ${card.done}/${card.total}` : ""}
                                    </span>
                                  </text>
                                </box>
                                <Show when={card.readOnly}>
                                  <text flexShrink={0} fg={theme.text.muted}>{` ${t("read-only")}`}</text>
                                </Show>
                                <DodItemActions
                                  id={card.id}
                                  owner={card.owner}
                                  mine={card.mine}
                                  stale={card.stale}
                                  verify={card.verify}
                                  takeable={card.canTake}
                                  hideReason
                                  take={props.take}
                                  submit={props.submit}
                                  release={props.release}
                                  actionId={actionId(card)}
                                  armed={armed}
                                  setArmed={setArmed}
                                  act={act}
                                  submitted={submitted}
                                />
                              </box>
                              <Show
                                when={
                                  !card.canTake && card.takeRefusal && !FINISHED.has(card.state)
                                    ? card.takeRefusal
                                    : undefined
                                }
                              >
                                {(reason) => (
                                  <box paddingLeft={2}>
                                    <text fg={theme.text.muted} wrapMode="word">
                                      {reason()}
                                    </text>
                                  </box>
                                )}
                              </Show>
                            </box>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                </box>
              </>
            )}
          </Show>
          <Show when={view() === "list"}>
            <For each={remaining()}>
              {(item) => {
                const mine = () => item.mine === true
                const free = () => !item.owner || item.stale === true
                return (
                  <box flexDirection="row" paddingLeft={indent() + 3} paddingRight={1}>
                    <text flexShrink={0} fg={color(item.state)}>
                      {`${MARK[item.state] ?? "·"} `}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={theme.text.base} wrapMode="none" truncate>
                        <span style={{ fg: theme.text.muted }}>{`${item.id} `}</span>
                        {item.what || item.id}
                        <span style={{ fg: theme.text.muted }}>
                          {typeof item.total === "number" && item.total > 0 ? ` ${item.done}/${item.total}` : ""}
                        </span>
                      </text>
                    </box>
                    <Show when={item.stale && item.owner}>
                      <text flexShrink={0} fg={theme.text.muted}>
                        {` ${t("{name}, lease ran out", { name: item.owner ?? "" })}`}
                      </text>
                    </Show>
                    <DodItemActions
                      id={item.id}
                      owner={item.owner ?? undefined}
                      mine={mine()}
                      stale={item.stale ?? undefined}
                      verify={item.verify ?? undefined}
                      takeable={free() && !item.waits}
                      blockedReason={item.waits ? t("waits for {items}", { items: item.waits.join(", ") }) : undefined}
                      take={props.take}
                      submit={props.submit}
                      release={props.release}
                      actionId={actionId(item)}
                      armed={armed}
                      setArmed={setArmed}
                      act={act}
                      submitted={submitted}
                    />
                  </box>
                )
              }}
            </For>
            <Show when={items().length > 0 && remaining().length === 0}>
              <box paddingLeft={indent() + 3} paddingRight={1}>
                <text fg={theme.text.feedback.success.base}>{t("Everything is done.")}</text>
              </box>
            </Show>
            <Show when={items().length === 0}>
              <box paddingLeft={indent() + 3} paddingRight={1}>
                <text fg={theme.text.muted}>{t("The DoD file exists but contains no tasks.")}</text>
              </box>
            </Show>
          </Show>
          <For each={events()}>
            {(event) => (
              <box paddingLeft={indent() + 3} paddingRight={1}>
                <text fg={theme.text.muted} wrapMode="none" truncate>
                  {`${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} `}
                  <span style={{ fg: theme.text.base }}>{event.who === "host" ? t("host") : event.who}</span>
                  {` ${verb(event)}${event.item ? ` ${event.item}` : ""}${event.detail ? `: ${event.detail}` : ""}`}
                </text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </>
  )
}

// The actions on one DoD item, shared by the list and the kanban board: take a
// card the viewer may take (or the reason it cannot be taken), and, for a held
// card, the holder, submit for one's own card, and give back. Freeing another
// person's card needs a second click; giving back one's own does not.
function DodItemActions(props: {
  id: string
  owner?: string
  mine: boolean
  stale?: boolean
  verify?: string
  // Whether the viewer may take this card now; when false, blockedReason says why.
  takeable: boolean
  blockedReason?: string
  // The caller shows the reason itself (for example on its own line under the card).
  hideReason?: boolean
  take?: (item?: string) => Promise<RoomDod>
  submit?: (item: string) => Promise<RoomDod>
  release: (item: string) => Promise<RoomDod>
  actionId: string
  armed: () => string | undefined
  setArmed: (id: string | undefined) => void
  act: (action: () => Promise<RoomDod>, done?: (dod: RoomDod) => void) => void
  submitted: (item: string) => (dod: RoomDod) => void
}) {
  const theme = useTheme()
  const t = useT()
  const [takeHovered, setTakeHovered] = createSignal(false)
  const [submitHovered, setSubmitHovered] = createSignal(false)
  const [releaseHovered, setReleaseHovered] = createSignal(false)
  const held = () => props.owner !== undefined && props.stale !== true
  return (
    <Show
      when={!held()}
      fallback={
        <>
          <text flexShrink={0} fg={props.mine ? theme.text.formfield.base : theme.text.muted}>
            {` ${props.mine ? t("you") : props.owner}`}
          </text>
          <Show when={props.mine && props.verify ? props.submit : undefined}>
            {(submit) => (
              <HoverAction
                id={`${props.actionId}:submit`}
                onHoverChange={setSubmitHovered}
                onClick={() => props.act(() => submit()(props.id), props.submitted(props.id))}
              >
                <text fg={submitHovered() ? theme.text.base : theme.text.action.primary.base}>{` ${t("submit")}`}</text>
              </HoverAction>
            )}
          </Show>
          <Show when={props.mine || !props.take}>
            <HoverAction
              id={`${props.actionId}:release`}
              variant="destructive"
              onHoverChange={setReleaseHovered}
              onMouseLeave={() => props.setArmed(undefined)}
              onClick={() => {
                if (!props.mine && props.armed() !== props.actionId) return props.setArmed(props.actionId)
                props.setArmed(undefined)
                props.act(() => props.release(props.id))
              }}
            >
              <text
                fg={
                  props.armed() === props.actionId
                    ? theme.text.action.destructive.focused
                    : releaseHovered()
                      ? hoverForeground(theme,"destructive")
                      : theme.text.action.destructive.base
                }
              >
                {props.armed() === props.actionId ? ` ${t("free?")}` : props.mine ? ` ${t("release")}` : " ×"}
              </text>
            </HoverAction>
          </Show>
        </>
      }
    >
      <Show
        when={props.takeable}
        fallback={
          <Show when={!props.hideReason}>
            <box flexShrink={1} minWidth={0}>
              <text fg={theme.text.muted} wrapMode="none" truncate>
                {` ${props.blockedReason ?? ""}`}
              </text>
            </box>
          </Show>
        }
      >
        <Show when={props.take}>
          {(take) => (
            <HoverAction
              id={`${props.actionId}:take`}
              onHoverChange={setTakeHovered}
              onClick={() => props.act(() => take()(props.id))}
            >
              <text fg={takeHovered() ? theme.text.base : theme.text.action.primary.base}>{` ${t("take")}`}</text>
            </HoverAction>
          )}
        </Show>
      </Show>
    </Show>
  )
}

const VERB: Record<RoomEvent["kind"], string> = {
  join: "joined",
  leave: "left",
  remove: "was removed",
  ban: "was banned",
  take: "took",
  release: "gave back",
  expire: "lost by lease",
  pass: "passed",
  fail: "failed",
  run: "ran",
}
