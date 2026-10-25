import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import type { JSX } from "solid-js"
import { Button } from "@orchestra/ui/button"
import { useI18n } from "@orchestra/ui/context/i18n"
import { createLatest, useExtension, type MountedSession } from "../sdk"
import { loadScope } from "./load"
import {
  heaviestFirst,
  kinds,
  scopes,
  segments,
  tokenKind,
  total,
  type Entry,
  type Kind,
  type Scope,
} from "./scope"

type Tokens = Entry["tokens"]

// One theme color per token kind, shared by the bar and its legend.
const color: Record<Kind, string> = {
  input: "var(--icon-info-base)",
  cacheRead: "var(--icon-success-base)",
  cacheWrite: "var(--icon-warning-base)",
  output: "var(--icon-interactive-base)",
  reasoning: "var(--icon-weak-base)",
}

/**
 * The context overview: how full the window is, split by token kind, for the routed session, its project, or the
 * project's group. Project and group totals add up what each session used; only the session has a window to fill.
 */
export function ContextOverview(props: {
  session: MountedSession
  /** The routed session's latest request: its tokens, their total and the model's context limit. Undefined before any. */
  usage: { tokens: Tokens; total: number; limit: number | undefined } | undefined
  /** The routed session's cost so far. */
  cost: number
  /** Changes whenever the session does new work, so a project or group total loads again. */
  rev: number
}) {
  const ctx = useExtension()
  const i18n = useI18n()
  const [scope, setScope] = createSignal<Scope>("session")

  const compact = createMemo(() => new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 1 }))
  const usd = createMemo(() => new Intl.NumberFormat(i18n.locale(), { style: "currency", currency: "USD" }))
  const percent = (value: number) => `${(value * 100).toLocaleString(i18n.locale(), { maximumFractionDigits: 1 })}%`

  const key = createMemo(
    () => {
      const id = props.session.id

      if (scope() === "session" || !id || !props.session.server.connected) return

      return { scope: scope(), id, directory: props.session.directory, rev: props.rev }
    },
    undefined,
    { equals: (a, b) => a?.scope === b?.scope && a?.id === b?.id && a?.directory === b?.directory && a?.rev === b?.rev },
  )

  const loaded = createLatest(key, async (value, signal) => ({
    scope: value.scope,
    result: await loadScope({
      client: props.session.server.client,
      scope: value.scope === "group" ? "group" : "project",
      sessionID: value.id,
      directory: value.directory,
      signal,
    }),
  }))

  // The scope's own result: never the previous scope's while the new one loads.
  const current = createMemo(() => (loaded.latest?.scope === scope() ? loaded.latest.result : undefined))

  const ready = createMemo(() => {
    const result = current()

    return result?.state === "ready" ? result : undefined
  })

  const entries = createMemo(() => heaviestFirst(ready()?.entries ?? []))
  const sum = createMemo(() => total(entries()))

  // What the bar measures: the model's window for a session, the scope's own token total for a project or group.
  const bar = createMemo(() => {
    if (scope() === "session") {
      if (!props.usage) return

      return { tokens: props.usage.tokens, whole: props.usage.limit ?? props.usage.total, used: props.usage.total }
    }

    const used = kinds.reduce((count, kind) => count + tokenKind(sum().tokens, kind), 0)

    return { tokens: sum().tokens, whole: used, used }
  })

  const cost = () => (scope() === "session" ? props.cost : sum().cost)

  const free = () => {
    const limit = props.usage?.limit

    return scope() === "session" && limit && props.usage ? Math.max(limit - props.usage.total, 0) : undefined
  }

  return (
    <div data-slot="context-overview" class="flex flex-col gap-4">
      <div class="flex items-center gap-1" role="tablist">
        <For each={scopes}>
          {(item) => (
            <Button
              size="small"
              variant={scope() === item ? "outline" : "ghost"}
              role="tab"
              aria-selected={scope() === item}
              onClick={() => setScope(item)}
            >
              {ctx.t(`scope.${item}`)}
            </Button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={scope() !== "session" && loaded.error}>
          <Note>{ctx.t("scope.failed")}</Note>
        </Match>
        <Match when={scope() !== "session" && !current()}>
          <Note>{ctx.t("scope.loading")}</Note>
        </Match>
        <Match when={current()?.state === "no-project" && scope() !== "session"}>
          <Note>{ctx.t("scope.noProject")}</Note>
        </Match>
        <Match when={current()?.state === "no-group" && scope() !== "session"}>
          <Note>{ctx.t("scope.noGroup")}</Note>
        </Match>
        <Match when={bar()}>
          {(item) => (
            <>
              <div class="flex flex-col gap-2">
                <div class="flex items-baseline justify-between gap-3">
                  <div class="text-14-medium text-text-strong">
                    {scope() === "session"
                      ? ctx.t("overview.used", { percent: item().whole > 0 ? percent(item().used / item().whole) : "—" })
                      : ctx.t("overview.total", { title: ready()?.title ?? "" })}
                  </div>
                  <div class="text-12-regular text-text-weak">
                    {scope() === "session" && props.usage?.limit
                      ? `${compact().format(item().used)} / ${compact().format(props.usage.limit)}`
                      : compact().format(item().used)}
                  </div>
                </div>
                <div class="flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface-base-active">
                  <For each={segments(item().tokens, item().whole)}>
                    {(segment) => (
                      <div
                        class="h-full"
                        style={{ width: `${segment.share * 100}%`, background: color[segment.kind] }}
                        title={ctx.t(`kind.${segment.kind}`)}
                      />
                    )}
                  </For>
                </div>
              </div>

              <div class="flex flex-col gap-2">
                <For each={kinds}>
                  {(kind) => (
                    <Row
                      swatch={color[kind]}
                      label={ctx.t(`kind.${kind}`)}
                      tokens={compact().format(tokenKind(item().tokens, kind))}
                      share={item().whole > 0 ? percent(tokenKind(item().tokens, kind) / item().whole) : "—"}
                    />
                  )}
                </For>
                <Show when={free()}>
                  {(left) => (
                    <Row
                      label={ctx.t("overview.free")}
                      tokens={compact().format(left())}
                      share={percent(left() / (props.usage?.limit ?? 1))}
                    />
                  )}
                </Show>
                <Row label={ctx.t("overview.cost")} tokens={usd().format(cost())} />
              </div>

              <Show when={scope() !== "session" && entries().length > 0}>
                <div class="flex flex-col gap-2">
                  <div class="text-12-regular text-text-weak">{ctx.t(`scope.${scope()}.entries`)}</div>
                  <For each={entries()}>
                    {(entry) => {
                      const used = () => kinds.reduce((count, kind) => count + tokenKind(entry.tokens, kind), 0)

                      return (
                        <div class="flex flex-col gap-1">
                          <div class="flex items-baseline justify-between gap-3">
                            <div class="min-w-0 truncate text-12-medium text-text-strong">{entry.title}</div>
                            <div class="shrink-0 text-12-regular text-text-weak">
                              {compact().format(used())} · {usd().format(entry.cost)}
                            </div>
                          </div>
                          <div class="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-base-active">
                            <For each={segments(entry.tokens, item().whole)}>
                              {(segment) => (
                                <div
                                  class="h-full"
                                  style={{ width: `${segment.share * 100}%`, background: color[segment.kind] }}
                                />
                              )}
                            </For>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Match>
        <Match when={true}>
          <Note>{ctx.t("overview.empty")}</Note>
        </Match>
      </Switch>
    </div>
  )
}

function Note(props: { children: JSX.Element }) {
  return <div class="text-12-regular text-text-weak">{props.children}</div>
}

function Row(props: { swatch?: string; label: string; tokens: string; share?: string }) {
  return (
    <div class="flex items-center gap-2 text-12-regular">
      <div
        class="size-2.5 shrink-0 rounded-sm"
        style={{ background: props.swatch ?? "var(--surface-base-active)" }}
      />
      <div class="min-w-0 flex-1 truncate text-text-base">{props.label}</div>
      <div class="shrink-0 text-text-weak">{props.tokens}</div>
      <Show when={props.share}>
        <div class="w-14 shrink-0 text-right text-text-strong">{props.share}</div>
      </Show>
    </div>
  )
}
