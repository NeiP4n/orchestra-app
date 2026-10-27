import { Plugin } from "@orchestra/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { homedir } from "node:os"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { HoverAction } from "../../component/hover-action"
import { useClient } from "../../context/client"
import { useToast } from "../../ui/toast"
import { contextUsage } from "../../util/session"
import {
  contextBreakdown,
  heaviestFirst,
  kinds,
  scopes,
  sumOf,
  total,
  type Scope,
  type Tokens,
} from "../../util/context-scope"
import { loadScope } from "../../util/context-scope-load"
import { Locale } from "../../util/locale"
import { useCompactLayout } from "../../ui/compact-layout"
import { useT } from "../../util/i18n"
import { canonicalToolName, executeCalls } from "../../util/tool-display"
import { DOD_PANEL, SidebarDod, SidebarDodPanel } from "./dod"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const MAX_ENTRIES = 8

const scopeLabel = { session: "Session", project: "Project", group: "Group" } as const

function measureChars(val: unknown): number {
  if (val === null || val === undefined) return 0
  if (typeof val === "string") return val.length
  if (typeof val === "number" || typeof val === "boolean") return String(val).length
  if (Array.isArray(val)) {
    return val.reduce((acc, item) => acc + measureChars(item), 0)
  }
  if (typeof val === "object") {
    try {
      return JSON.stringify(val).length
    } catch {
      return 0
    }
  }
  return 0
}

/**
 * Parses user input for compaction threshold.
 * Supports:
 * - '400k', '80K' (* 1,000)
 * - '1m', '0.5M' (* 1,000,000)
 * - raw numbers like '200000', '200,000'
 * - '0', 'all', 'max', 'весь', 'весь лимит' -> 0 (no threshold / context window limit)
 */
export function parseCompactionThreshold(input: string): number | undefined {
  if (typeof input !== "string") return undefined
  const cleaned = input.trim().toLowerCase().replace(/,/g, "")
  if (!cleaned) return undefined
  if (
    cleaned === "0" ||
    cleaned === "all" ||
    cleaned === "max" ||
    cleaned === "весь" ||
    cleaned === "весь лимит" ||
    cleaned === "без сжатия" ||
    cleaned === "без лимита" ||
    cleaned === "full" ||
    cleaned === "full window" ||
    cleaned === "no limit" ||
    cleaned === "none" ||
    cleaned === "off" ||
    cleaned === "disabled"
  ) {
    return 0
  }
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/i)
  if (!match) return undefined
  const num = parseFloat(match[1])
  if (Number.isNaN(num) || num < 0) return undefined
  const unit = match[2]?.toLowerCase()
  if (unit === "k") return Math.round(num * 1000)
  if (unit === "m") return Math.round(num * 1000000)
  return Math.round(num)
}

/**
 * Formats compaction threshold for display.
 */
export function formatCompactionThreshold(threshold: number, isRu: boolean = false): string {
  if (threshold <= 0) return isRu ? "Весь лимит" : "Context limit"
  if (threshold >= 1000000) {
    const m = threshold / 1000000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`
  }
  if (threshold >= 1000) {
    const k = threshold / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  return String(threshold)
}

/**
 * Extracts default compaction threshold from server configuration.
 * Handles both canonical Array<Config.Entry> from client.config.get()
 * and plain mock objects { compaction: { threshold } }.
 */
export function extractServerCompactionThreshold(cfg: unknown): number | undefined {
  if (!cfg) return undefined
  if (Array.isArray(cfg)) {
    const doc = cfg.findLast(
      (entry) =>
        entry &&
        entry.type === "document" &&
        entry.info &&
        typeof entry.info === "object" &&
        entry.info.compaction?.threshold !== undefined,
    )
    if (doc && doc.type === "document" && typeof doc.info?.compaction?.threshold === "number") {
      return doc.info.compaction.threshold
    }
    return undefined
  }
  if (typeof cfg === "object") {
    const obj = cfg as any
    if (typeof obj.compaction?.threshold === "number") {
      return obj.compaction.threshold
    }
  }
  return undefined
}

/**
 * Direct fallback for saving compaction threshold to ~/.config/orchestra/orchestra.jsonc or orchestra.json
 */
export async function saveDirectFallback(threshold: number): Promise<boolean> {
  try {
    const configDir = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
    const configPaths = [
      path.join(configDir, "orchestra", "orchestra.jsonc"),
      path.join(configDir, "orchestra", "orchestra.json"),
      path.join(configDir, "orchestra", "opencode.jsonc"),
      path.join(configDir, "orchestra", "opencode.json"),
      path.join(configDir, "opencode", "orchestra.jsonc"),
      path.join(configDir, "opencode", "orchestra.json"),
      path.join(configDir, "opencode", "opencode.jsonc"),
      path.join(configDir, "opencode", "opencode.json"),
    ]
    let updated = false
    for (const p of configPaths) {
      try {
        const raw = await readFile(p, "utf-8")
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^\\:])\/\/.*$/gm, "$1")
        const json = JSON.parse(stripped)
        if (!json.compaction || typeof json.compaction !== "object") {
          json.compaction = {}
        }
        json.compaction.threshold = threshold
        await writeFile(p, JSON.stringify(json, null, 2), "utf-8")
        updated = true
      } catch {
        // file doesn't exist or not readable, try next
      }
    }
    if (!updated) {
      try {
        const targetDir = path.join(configDir, "orchestra")
        await mkdir(targetDir, { recursive: true })
        const targetFile = path.join(targetDir, "orchestra.json")
        await writeFile(
          targetFile,
          JSON.stringify({ compaction: { auto: true, threshold } }, null, 2),
          "utf-8",
        )
        updated = true
      } catch {}
    }
    return updated
  } catch {
    return false
  }
}

/**
 * Calculates token usage by Tools and MCP calls from session messages.
 * Estimates tokens as input and output characters / 4.
 */
export function estimateToolTokens(messages: readonly any[]): number {
  let totalChars = 0
  let explicitTokens = 0

  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue

    const candidates: any[] = []
    if (Array.isArray(message.content)) candidates.push(...message.content)
    if (Array.isArray(message.parts)) candidates.push(...message.parts)
    if (Array.isArray(message.tools)) candidates.push(...message.tools)
    if (Array.isArray(message.tool_calls)) candidates.push(...message.tool_calls)
    if (Array.isArray(message.toolCalls)) candidates.push(...message.toolCalls)

    if (
      message.type === "tool" ||
      message.type === "tool_call" ||
      message.type === "tool_use" ||
      message.role === "tool"
    ) {
      candidates.push(message)
    }

    for (const part of candidates) {
      if (!part || typeof part !== "object") continue

      const isTool =
        part.type === "tool" ||
        part.type === "tool_call" ||
        part.type === "tool_use" ||
        part.role === "tool" ||
        Boolean(part.tool_call) ||
        typeof part.tool === "string" ||
        (typeof part.name === "string" && !part.type)

      if (!isTool) continue

      if (typeof part.tokens === "number") {
        explicitTokens += part.tokens
        continue
      }
      if (typeof part.state?.tokens === "number") {
        explicitTokens += part.state.tokens
        continue
      }

      let inputChars = 0
      const input = part.state?.input ?? part.input ?? part.arguments ?? part.args ?? part.tool_call?.arguments
      if (input !== undefined) {
        inputChars += measureChars(input)
      }

      let outputChars = 0
      const output =
        part.state?.content ??
        part.state?.output ??
        part.state?.result ??
        part.output ??
        part.result ??
        (part.type === "tool" ? undefined : part.content)
      if (output !== undefined) {
        outputChars += measureChars(output)
      }

      if (part.state?.metadata?.toolCalls || part.metadata?.toolCalls || part.toolCalls) {
        const calls = part.state?.metadata?.toolCalls ?? part.metadata?.toolCalls ?? part.toolCalls
        if (Array.isArray(calls)) {
          for (const call of calls) {
            if (call.input) inputChars += measureChars(call.input)
            if (call.output) outputChars += measureChars(call.output)
            if (call.result) outputChars += measureChars(call.result)
          }
        }
      }

      if (inputChars === 0 && outputChars === 0) {
        totalChars += measureChars(part)
      } else {
        totalChars += inputChars + outputChars
      }
    }
  }

  const estimated = Math.ceil(totalChars / 4)
  return explicitTokens + estimated
}

export type BarCell = {
  kind: { id: string; label: string; glyph: string }
  cells: number
}

/**
 * Calculates bar cells including standard kinds plus Tools & MCP segment when toolTokens > 0.
 */
export function computeBarCells(
  tokens: Tokens,
  whole: number,
  width: number,
  toolTokens: number = 0,
): BarCell[] {
  if (whole <= 0 || width <= 0) return []

  const allKinds: Array<{ id: string; label: string; glyph: string; count: number }> = kinds.map((k) => ({
    ...k,
    count: tokens[k.id],
  }))

  if (toolTokens > 0) {
    allKinds.push({
      id: "tools",
      label: "Tools & MCP",
      glyph: "⎔",
      count: toolTokens,
    })
  }

  const cells = allKinds.flatMap((kind) => {
    const count = kind.count
    return count > 0 ? [{ kind, cells: Math.max(1, Math.round((count / whole) * width)) }] : []
  })

  let excess = cells.reduce((count, item) => count + item.cells, 0) - width
  while (excess > 0 && cells.length > 0) {
    const widest = cells.reduce((best, item) => (item.cells > best.cells ? item : best), cells[0]!)
    if (widest.cells <= 1) break
    widest.cells -= 1
    excess -= 1
  }

  return cells
}

export function extractToolMetrics(messages: readonly any[]) {
  const counts: Record<string, number> = {}
  let total = 0

  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue

    const candidates: any[] = []
    if (Array.isArray(message.content)) candidates.push(...message.content)
    if (Array.isArray(message.parts)) candidates.push(...message.parts)
    if (Array.isArray(message.tools)) candidates.push(...message.tools)
    if (Array.isArray(message.tool_calls)) candidates.push(...message.tool_calls)
    if (Array.isArray(message.toolCalls)) candidates.push(...message.toolCalls)

    if (message.type === "tool" || message.type === "tool_call" || message.type === "tool_use") {
      candidates.push(message)
    }

    for (const part of candidates) {
      if (!part || typeof part !== "object") continue

      let toolName: string | undefined

      if (part.type === "tool" || part.type === "tool_call" || part.type === "tool_use") {
        toolName = part.name ?? part.tool ?? part.tool_name
      } else if (part.tool_call) {
        toolName = part.tool_call.name ?? part.tool_call.tool
      } else if (typeof part.name === "string" && !part.type) {
        toolName = part.name
      } else if (typeof part.tool === "string") {
        toolName = part.tool
      }

      if (!toolName) continue

      const canonical = canonicalToolName(toolName)

      if (canonical === "execute") {
        const nested = executeCalls(
          part.state?.status === "streaming"
            ? undefined
            : (part.state?.metadata?.toolCalls ?? part.metadata?.toolCalls ?? part.toolCalls),
        )
        if (nested.length > 0) {
          for (const call of nested) {
            const nestedName = canonicalToolName(call.tool)
            counts[nestedName] = (counts[nestedName] ?? 0) + 1
            total++
          }
          continue
        }
      }

      counts[canonical] = (counts[canonical] ?? 0) + 1
      total++
    }
  }

  const entries = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    total,
    counts,
    entries,
    top: entries.slice(0, 5),
  }
}

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const t = useT()
  const layout = useCompactLayout()
  let client: ReturnType<typeof useClient> | undefined
  try {
    client = useClient()
  } catch {
    client = undefined
  }
  let toast: ReturnType<typeof useToast> | undefined
  try {
    toast = useToast()
  } catch {
    toast = undefined
  }

  const [scope, setScope] = createSignal<Scope>("session")
  // The sidebar's side padding (2 + 2, or 1 + 1 when compact) plus the column reserved for the scrollbar.
  const barWidth = () => Math.max(1, layout.sidebarWidth() - (layout.compact() ? 3 : 5))
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const toolTokens = createMemo(() => estimateToolTokens(msg()))

  const isRu = () => {
    const p = t("Project")
    return p === "Проект"
  }
  const toolLabel = () => {
    const translated = t("Tools & MCP")
    if (translated !== "Tools & MCP") return translated
    return isRu() ? "Инструменты и MCP" : "Tools & MCP"
  }

  // Load server-wide config to retrieve default compaction threshold
  const [serverConfig, { refetch }] = createResource(() =>
    props.context.client?.config?.get
      ? props.context.client.config.get().catch(() => undefined)
      : client?.api?.config?.get
        ? client.api.config.get().catch(() => undefined)
        : Promise.resolve(undefined),
  )

  const [threshold, setThreshold] = createSignal<number>(0)

  createEffect(() => {
    const sessionMeta = (session() as any)?.metadata?.compaction_threshold
    if (sessionMeta !== undefined && sessionMeta !== null) {
      const parsed = parseCompactionThreshold(String(sessionMeta))
      if (parsed !== undefined) {
        setThreshold(parsed)
        return
      }
    }
    const def = extractServerCompactionThreshold(serverConfig())
    if (def !== undefined && def > 0) {
      setThreshold(def)
    }
  })

  async function handleCompactionPrompt() {
    const dialog = props.context.ui?.dialog
    if (!dialog) return

    const currentFormatted =
      threshold() > 0 ? (threshold() >= 1000 ? `${threshold() / 1000}k` : String(threshold())) : "0"

    const input = await dialog.prompt({
      title: isRu() ? "Порог автосжатия контекста" : "Context auto-compaction threshold",
      placeholder: isRu()
        ? "например: 400k, 200000, 80k или 0 для всего лимита"
        : "e.g.: 400k, 200000, 80k or 0 for context limit",
      value: currentFormatted,
    })

    if (input === undefined) return
    const parsed = parseCompactionThreshold(input)
    if (parsed === undefined) return

    setThreshold(parsed)

    try {
      if (props.context.client?.session?.update) {
        await (props.context.client.session.update as any)({
          sessionID: props.sessionID,
          metadata: { compaction_threshold: parsed },
        })
      } else if (client?.api?.session?.update) {
        await (client.api.session.update as any)({
          sessionID: props.sessionID,
          metadata: { compaction_threshold: parsed },
        })
      }
    } catch {
      // Ignore session update error in test environments
    }

    const makeDefault = await dialog.confirm({
      title: isRu() ? "Порог автосжатия" : "Auto-compaction threshold",
      message: isRu()
        ? "Сделать этот порог дефолтом для всех новых чатов при создании?"
        : "Make this threshold the default for all new chats on creation?",
    })

    if (makeDefault) {
      try {
        if (props.context.client?.config?.update) {
          await (props.context.client.config.update as any)({
            compaction: { threshold: parsed },
          })
        } else if (client?.api?.config?.update) {
          await (client.api.config.update as any)({
            compaction: { threshold: parsed },
          })
        }
        await saveDirectFallback(parsed)
        await refetch()
        toast?.show({
          variant: "success",
          message: isRu()
            ? `Порог автосжатия (${formatCompactionThreshold(parsed, isRu())}) сохранен в конфигурацию`
            : `Auto-compaction threshold (${formatCompactionThreshold(parsed, isRu())}) saved to configuration`,
        })
      } catch {
        toast?.show({
          variant: "error",
          message: isRu() ? "Не удалось сохранить конфигурацию" : "Failed to update configuration",
        })
      }
    }
  }

  const state = createMemo(() =>
    contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID),
  )
  const held = createMemo(() => contextBreakdown(msg(), session()?.revert?.messageID))
  // A nearly full window is about to compact, which is worth flagging as status feedback.
  const level = (percent: number) => {
    if (percent >= 90) return theme.text.feedback.error.base
    if (percent >= 75) return theme.text.feedback.warning.base
    return theme.text.base
  }

  // A project or group adds up what its sessions used; it loads again when this session does new work.
  const key = createMemo(() => {
    const current = scope()
    if (current === "session") return
    return { scope: current, sessionID: props.sessionID, directory: session()?.location.directory, rev: msg().length }
  })
  const [scoped] = createResource(key, (value) =>
    client?.api
      ? loadScope({ api: client.api, ...value, signal: new AbortController().signal }).catch(() => undefined)
      : Promise.resolve(undefined),
  )
  const ready = () => {
    const result = scoped.latest
    return result?.state === "ready" ? result : undefined
  }
  const entries = createMemo(() => heaviestFirst(ready()?.entries ?? []))
  const sum = createMemo(() => total(entries()))

  // What the bar measures: the model's window for a session, the scope's own token total otherwise.
  const bar = createMemo(() => {
    if (scope() === "session") {
      const tokens = held()
      const used = state()?.tokens ?? 0
      return tokens && used > 0 ? { tokens, used, whole: state()?.limit ?? used } : undefined
    }
    const used = sumOf(sum().tokens)
    return used > 0 ? { tokens: sum().tokens, used, whole: used } : undefined
  })
  const spent = () => (scope() === "session" ? cost() : sum().cost)
  const share = (count: number, whole: number) => (whole > 0 ? `${((count / whole) * 100).toFixed(1)}%` : "")

  return (
    <>
      <SidebarDod context={props.context} sessionID={props.sessionID} />
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <b>{t("Context")}</b>
          </text>
          <Show when={scope() === "session" && state()?.percent}>
            {(percent) => <text fg={level(percent())}>{t("{percent}% used", { percent: percent() })}</text>}
          </Show>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={scopes}>
            {(item) => (
              <HoverAction id={`sidebar.context.${item}`} onClick={() => setScope(item)} paddingRight={1}>
                <text
                  fg={scope() === item ? theme.text.base : theme.text.muted}
                  attributes={scope() === item ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
                >
                  {t(scopeLabel[item])}
                </text>
              </HoverAction>
            )}
          </For>
        </box>
        <Show when={scope() === "session"}>
          <box flexDirection="row" justifyContent="space-between" gap={1} paddingTop={1}>
            <text fg={theme.text.muted} wrapMode="none">
              {isRu() ? "Автосжатие при:" : "Auto-compaction at:"}
            </text>
            <HoverAction id="sidebar.context.compaction" onClick={handleCompactionPrompt}>
              <text fg={theme.text.base} wrapMode="none">
                {formatCompactionThreshold(threshold(), isRu())} ✎
              </text>
            </HoverAction>
          </box>
        </Show>
        <Show when={scope() !== "session" && scoped.loading && !scoped.latest}>
          <text fg={theme.text.muted}>{t("Loading usage…")}</text>
        </Show>
        <Show when={scope() !== "session" && !scoped.loading && scoped.latest === undefined}>
          <text fg={theme.text.muted}>{t("Could not load usage for this scope.")}</text>
        </Show>
        <Show when={scope() !== "session" && scoped.latest?.state === "no-project"}>
          <text fg={theme.text.muted}>{t("This session does not belong to a project.")}</text>
        </Show>
        <Show when={scope() !== "session" && scoped.latest?.state === "no-group"}>
          <text fg={theme.text.muted}>{t("This session's project is not in a group.")}</text>
        </Show>
        <Show when={bar()}>
          {(item) => {
            const cells = () =>
              computeBarCells(
                item().tokens,
                item().whole,
                barWidth(),
                scope() === "session" ? toolTokens() : 0,
              )
            return (
              <>
                <Show when={scope() !== "session" && ready()}>
                  {(result) => (
                    <text fg={theme.text.base} wrapMode="none">
                      {Locale.truncate(result().title, barWidth())}
                    </text>
                  )}
                </Show>
                <text wrapMode="none">
                  <For each={cells()}>
                    {(part) => (
                      <span style={{ fg: scope() === "session" ? level(state()?.percent ?? 0) : theme.text.base }}>
                        {part.kind.glyph.repeat(part.cells)}
                      </span>
                    )}
                  </For>
                  <span style={{ fg: theme.text.muted }}>
                    {"·".repeat(Math.max(0, barWidth() - cells().reduce((count, part) => count + part.cells, 0)))}
                  </span>
                </text>
                <Show when={scope() === "session" && state()?.percent !== undefined}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {isRu()
                      ? `${state()?.percent ?? 0}% из 100% лимита контекста`
                      : `${state()?.percent ?? 0}% of context limit`}
                  </text>
                </Show>
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {Locale.number(item().used)}
                    <Show when={scope() === "session" && state()?.limit}>
                      {(limit) => ` / ${Locale.number(limit())}`}
                    </Show>{" "}
                    {t("tokens")}
                  </text>
                  <Show when={spent() > 0}>
                    <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                      {t("{cost} spent", { cost: money.format(spent()) })}
                    </text>
                  </Show>
                </box>
                <For each={kinds.filter((kind) => item().tokens[kind.id] > 0)}>
                  {(kind) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.muted}>{kind.glyph}</text>
                      <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                        {t(kind.label)}
                      </text>
                      <text fg={theme.text.muted} wrapMode="none">
                        {Locale.number(item().tokens[kind.id])}
                      </text>
                      <text fg={theme.text.base} wrapMode="none">
                        {share(item().tokens[kind.id], item().whole).padStart(6)}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={scope() === "session" && toolTokens() > 0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.muted}>⎔</text>
                    <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                      {toolLabel()}
                    </text>
                    <text fg={theme.text.muted} wrapMode="none">
                      {Locale.number(toolTokens())}
                    </text>
                    <text fg={theme.text.base} wrapMode="none">
                      {share(toolTokens(), item().whole).padStart(6)}
                    </text>
                  </box>
                </Show>
                <Show when={scope() === "session" && state()?.limit && item().whole > item().used}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.muted}>·</text>
                    <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                      {t("Free space")}
                    </text>
                    <text fg={theme.text.muted} wrapMode="none">
                      {Locale.number(item().whole - item().used)}
                    </text>
                    <text fg={theme.text.base} wrapMode="none">
                      {share(item().whole - item().used, item().whole).padStart(6)}
                    </text>
                  </box>
                </Show>
                <Show when={scope() !== "session" && entries().length > 0}>
                  <box paddingTop={1}>
                    <text fg={theme.text.muted}>
                      {t(scope() === "project" ? "Sessions in this project" : "Projects in this group")}
                    </text>
                    <For each={entries().slice(0, MAX_ENTRIES)}>
                      {(entry) => (
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                            {Locale.truncate(entry.title, Math.max(4, barWidth() - 8))}
                          </text>
                          <text fg={theme.text.muted} wrapMode="none">
                            {Locale.number(sumOf(entry.tokens))}
                          </text>
                        </box>
                      )}
                    </For>
                    <Show when={entries().length > MAX_ENTRIES}>
                      <text fg={theme.text.muted}>{t("+{count} more", { count: entries().length - MAX_ENTRIES })}</text>
                    </Show>
                  </box>
                </Show>
              </>
            )
          }}
        </Show>
        <Show when={!bar() && scope() === "session" && cost() > 0}>
          <text fg={theme.text.muted} wrapMode="none">
            {t("{cost} spent", { cost: money.format(cost()) })}
          </text>
        </Show>
      </box>
    </>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === DOD_PANEL}>
          <SidebarDodPanel context={context} panel={panel} />
        </Show>
      ),
    })
  },
})
