import { useParams } from "@solidjs/router"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { RoomDodBoard, RoomDodBoardCard } from "@orchestra/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"

// DoD kanban board (serve/web). The host view: the web app connects as the
// server owner, so cards can never be taken from here — only freed. Taking
// belongs to guests (TUI/CLI). The board is the same data the API returns
// (room.dod.board), refreshed on the same 5s cadence the TUI list uses, so
// no new transport: a plain poll, not a new event stream.
//
// Route: /server/:serverKey/room/:roomID/dod (registered in shell/routes).
const REFRESH_MS = 5_000

const MARK: Record<string, string> = {
  NOT_STARTED: "·",
  IN_PROGRESS: "●",
  BLOCKED: "▲",
  FAILED: "✖",
  DONE: "✓",
  OUT_OF_SCOPE: "○",
}

export function DodBoardRoute() {
  const params = useParams<{ roomID: string }>()
  const server = useServer()
  const language = useLanguage()

  const [state, setState] = createStore({
    board: undefined as RoomDodBoard | undefined,
    error: undefined as string | undefined,
    releasing: undefined as string | undefined,
  })

  const load = async () => {
    try {
      const loaded = await server.ctx.sdk.api.room.dod.board({ roomID: params.roomID })

      setState({ board: loaded, error: undefined })
    } catch (thrown) {
      setState({ error: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }

  // The host frees a card someone else holds; the card goes back to the
  // free pile. The web page is the server owner, and the release is
  // explicit (one button per held card).
  const release = async (card: RoomDodBoardCard) => {
    setState({ releasing: card.id })

    try {
      await server.ctx.sdk.api.room.dod.release({ roomID: params.roomID, id: card.id })
      await load()
    } catch (thrown) {
      setState({ error: thrown instanceof Error ? thrown.message : String(thrown) })
    } finally {
      setState({ releasing: undefined })
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div data-slot="dod-board" class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-v2-text-text-base text-lg font-semibold">{language.t("dod.board.title")}</h1>
        <span class="text-v2-text-text-muted text-sm">{params.roomID}</span>
        <Show when={state.board}>
          {(loaded) => (
            <span class="text-v2-text-text-muted text-sm">
              {language.t("dod.board.counts", {
                done: loaded().counts.done,
                total: loaded().counts.total,
                inProgress: loaded().counts.inProgress,
                blocked: loaded().counts.blocked,
                failed: loaded().counts.failed,
                free: loaded().counts.free,
              })}
            </span>
          )}
        </Show>
        <button
          type="button"
          class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base"
          onClick={() => void load()}
        >
          {language.t("dod.board.refresh")}
        </button>
      </div>

      <Show when={state.board}>
        {(loaded) => (
          <Show when={loaded().zones.length > 0}>
            <p class="text-v2-text-text-muted text-sm">
              {language.t("dod.board.zones", {
                zones: loaded()
                  .zones.map((zone) => `${zone.name}${zone.mine ? ` ${language.t("dod.board.yours")}` : ""}`)
                  .join(" · "),
              })}
            </p>
          </Show>
        )}
      </Show>

      <Show when={state.error}>
        <p class="text-v2-text-text-danger">{state.error}</p>
      </Show>

      <Show when={!state.board && !state.error}>
        <p class="text-v2-text-text-muted">{language.t("dod.board.loading")}</p>
      </Show>

      <Show when={state.board}>
        {(loaded) => (
          <Show when={loaded().status !== "disabled"} fallback={<p class="text-v2-text-text-muted">{language.t("dod.board.noDod")}</p>}>
            <div class="grid min-h-0 flex-1 grid-cols-5 gap-3 max-lg:grid-cols-1">
              <For each={loaded().columns}>
                {(column) => (
                  <section
                    aria-label={column.title}
                    class="min-h-0 overflow-auto rounded-md border border-v2-border-border-base p-2"
                  >
                    <h2 class="text-v2-text-text-base mb-2 text-sm font-semibold">
                      {language.t("dod.board.columnCount", { title: column.title, count: column.cards.length })}
                    </h2>
                    <ul class="flex flex-col gap-2">
                      <For each={column.cards} fallback={<li class="text-v2-text-text-muted text-sm">{language.t("dod.board.noCards")}</li>}>
                        {(card) => (
                          <li class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-2">
                            <p class="text-v2-text-text-base text-sm">
                              <span class="text-v2-text-text-muted">{MARK[card.state] ?? "·"} </span>
                              <span class="text-v2-text-text-muted">{card.id} </span>
                              {card.what || card.id}
                              {Number(card.total) > 0 && (
                                <span class="text-v2-text-text-muted">
                                  {" "}
                                  {card.done}/{card.total}
                                </span>
                              )}
                            </p>
                            <Show when={card.owner}>
                              <p class="text-v2-text-text-muted text-xs">
                                {card.owner}
                                {card.stale ? ` · ${language.t("dod.board.stale")}` : ""}
                              </p>
                            </Show>
                            <Show when={card.zone}>
                              <p class="text-v2-text-text-muted text-xs">{language.t("dod.board.zone", { zone: card.zone ?? "" })}</p>
                            </Show>
                            <Show when={card.readOnly}>
                              <p class="text-v2-text-text-muted text-xs">{language.t("dod.board.readOnly")}</p>
                            </Show>
                            <Show when={card.waits && card.waits.length > 0}>
                              <p class="text-v2-text-text-muted text-xs">
                                {language.t("dod.board.waits", { waits: card.waits?.join(", ") ?? "" })}
                              </p>
                            </Show>
                            <Show when={card.owner}>
                              <button
                                type="button"
                                disabled={state.releasing === card.id}
                                class="mt-1 rounded-md border border-v2-border-border-base bg-v2-background-bg-subtle px-2 py-0.5 text-xs text-v2-text-text-base disabled:opacity-50"
                                onClick={() => void release(card)}
                              >
                                {state.releasing === card.id ? language.t("dod.board.freeing") : language.t("dod.board.freeCard")}
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}
