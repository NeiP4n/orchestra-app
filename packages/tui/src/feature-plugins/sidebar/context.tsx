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
import { formatMoney, formatRubles } from "../../util/money"
import { polzaSettings, syncPolza } from "../../util/polza"
import { useCompactLayout } from "../../ui/compact-layout"
import { useT } from "../../util/i18n"
import { canonicalToolName, executeCalls } from "../../util/tool-display"
import { DOD_PANEL, SidebarDod, SidebarDodPanel } from "./dod"


const MAX_ENTRIES = 8

const scopeLabel = { session: "Session", project: "Project", group: "Group", society: "Society" } as const

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

// Roughly what a screenshot or a PDF page costs the model: about 1.5k tokens for a 1280x960 image.
const IMAGE_TOKENS = 1_500

/** Splits a tool result into text the model reads and pictures it looks at. */
function measureOutput(val: unknown): { chars: number; images: number } {
  if (val === null || val === undefined) return { chars: 0, images: 0 }
  if (typeof val === "string") return { chars: val.length, images: 0 }
  if (typeof val === "number" || typeof val === "boolean") return { chars: String(val).length, images: 0 }
  if (Array.isArray(val)) {
    return val.reduce(
      (acc, item) => {
        const next = measureOutput(item)
        return { chars: acc.chars + next.chars, images: acc.images + next.images }
      },
      { chars: 0, images: 0 },
    )
  }
  if (typeof val === "object") {
    const item = val as { type?: unknown; uri?: unknown }
    // An image or a PDF arrives as a base64 data URI: counting those bytes as text would report
    // megabytes the model never reads.
    if (item.type === "file" && typeof item.uri === "string" && item.uri.startsWith("data:")) {
      return { chars: 0, images: 1 }
    }
    try {
      return { chars: JSON.stringify(val).length, images: 0 }
    } catch {
      return { chars: 0, images: 0 }
    }
  }
  return { chars: 0, images: 0 }
}

export type CompactionThresholdParsed =
  | { type: "tokens"; tokens: number }
  | { type: "percent"; percent: number }
  | { type: "capped"; percent: number; tokens: number }

/**
 * Parses a compaction threshold value from any representation:
 * - number of tokens: 120000, 0
 * - string of tokens: '400k', '1.5m', '200000', '200,000'
 * - string percent: '60%', ' 60 % '
 * - object: { percent: 60, tokens: 250000 }, { percent: 60 }, { tokens: 120000 }
 * - zero / disabled keywords: '0', 'none', 'off', 'full', 'all', 'max', 'весь', 'без сжатия' -> 0
 */
export function parseThresholdValue(value: unknown): CompactionThresholdParsed | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined
    return { type: "tokens", tokens: Math.round(value) }
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>
    const percent = typeof raw.percent === "number" ? raw.percent : undefined
    const rawTokens = raw.tokens
    let tokens: number | undefined
    if (typeof rawTokens === "number") {
      tokens = Number.isFinite(rawTokens) && rawTokens >= 0 ? Math.round(rawTokens) : undefined
    } else if (typeof rawTokens === "string") {
      tokens = parseCompactionThreshold(rawTokens)
    }
    if (percent !== undefined && tokens !== undefined) {
      if (percent <= 0 || percent > 100 || tokens < 0) return undefined
      return { type: "capped", percent, tokens }
    }
    if (percent !== undefined) {
      if (percent <= 0 || percent > 100) return undefined
      return { type: "percent", percent }
    }
    if (tokens !== undefined) {
      return tokens <= 0 ? { type: "tokens", tokens: 0 } : { type: "tokens", tokens }
    }
    return undefined
  }
  if (typeof value !== "string") return undefined
  const cleaned = value.trim().toLowerCase().replace(/,/g, "")
  if (!cleaned) return undefined
  if (
    cleaned === "0" ||
    cleaned === "0k" ||
    cleaned === "0m" ||
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
    return { type: "tokens", tokens: 0 }
  }
  const percentMatch = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/)
  if (percentMatch) {
    const percent = parseFloat(percentMatch[1])
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return undefined
    return { type: "percent", percent }
  }
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/i)
  if (!match) return undefined
  const num = parseFloat(match[1])
  if (Number.isNaN(num) || num < 0) return undefined
  const unit = match[2]?.toLowerCase()
  if (unit === "k") return { type: "tokens", tokens: Math.round(num * 1000) }
  if (unit === "m") return { type: "tokens", tokens: Math.round(num * 1000000) }
  return { type: "tokens", tokens: Math.round(num) }
}

/**
 * Parses user input for compaction threshold into integer tokens.
 * Supports:
 * - '400k', '80K' (* 1,000)
 * - '1m', '0.5M' (* 1,000,000)
 * - raw numbers like '200000', '200,000'
 * - '0', 'all', 'max', 'весь', 'весь лимит' -> 0 (no threshold / context window limit)
 * - percent like '60%' when window is provided -> Math.round(window * 0.6)
 * - object representations { percent, tokens }
 */
export function parseCompactionThreshold(input: unknown, window?: number): number | undefined {
  const parsed = parseThresholdValue(input)
  if (!parsed) return undefined
  if (parsed.type === "tokens") return parsed.tokens
  if (parsed.type === "percent") {
    if (window && window > 0) {
      return Math.max(1, Math.round((window * parsed.percent) / 100))
    }
    return undefined
  }
  if (parsed.type === "capped") {
    if (window && window > 0) {
      const share = Math.max(1, Math.round((window * parsed.percent) / 100))
      return Math.min(share, parsed.tokens)
    }
    return parsed.tokens
  }
  return undefined
}

/**
 * Formats compaction threshold for display. "No threshold" is translated by the caller through
 * i18n; every other value reads the same in every language.
 */
export function formatCompactionThreshold(threshold: number): string {
  if (threshold <= 0) return "Context limit"
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
    // A test or a stripped environment can lack both; writing under a literal "undefined" folder
    // would leave a config file the server never reads.
    const xdg = process.env.XDG_CONFIG_HOME
    const home = homedir()
    const configDir = xdg && path.isAbsolute(xdg) ? xdg : home ? path.join(home, ".config") : undefined
    if (!configDir) return false
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
  let images = 0

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
        const measured = measureOutput(output)
        outputChars += measured.chars
        images += measured.images
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

      if (inputChars === 0 && outputChars === 0 && images === 0) {
        totalChars += measureChars(part)
      } else {
        totalChars += inputChars + outputChars
      }
    }
  }

  const estimated = Math.ceil(totalChars / 4)
  // A picture is billed by how much of it the model sees, not by the base64 text that carries it.
  return explicitTokens + images * IMAGE_TOKENS + estimated
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
  const [measuredWidth, setMeasuredWidth] = createSignal<number>()
  const barWidth = () => Math.max(1, measuredWidth() ?? layout.sidebarWidth() - 3)
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const toolTokens = createMemo(() => estimateToolTokens(msg()))

  const toolLabel = () => barWidth() < 36 ? t("Tools/MCP") : t("Tools & MCP")

  // "Context limit" means "no threshold" and is the only label that changes with the language.
  const thresholdLabel = (value: number) => (value <= 0 ? t("Context limit") : formatCompactionThreshold(value))

  // Load server-wide config to retrieve default compaction threshold
  const [serverConfig, { refetch }] = createResource(() =>
    props.context.client?.config?.get
      ? props.context.client.config.get().catch(() => undefined)
      : client?.api?.config?.get
        ? client.api.config.get().catch(() => undefined)
        : Promise.resolve(undefined),
  )

  // What the account behind the models has left, and what it has spent in total. Polza keeps that
  // itself; other providers do not, so the block only appears for a configured Polza key.
  const polza = createMemo(() => polzaSettings(serverConfig()))
  const [apiBalance] = createResource(polza, (settings) => syncPolza(settings))
  // A Society tab would only ever report "not in a Society" without a council group.
  const [groups] = createResource(
    () => props.sessionID,
    () =>
      client?.api
        ? client.api.orchestra.group.list().catch(() => [])
        : Promise.resolve([] as ReadonlyArray<{ mode?: string }>),
  )
  const shownScopes = createMemo(() =>
    scopes.filter((item) => item !== "society" || (groups.latest ?? []).some((group) => (group.mode ?? "lead") === "council")),
  )

  const [threshold, setThreshold] = createSignal<number>(0)
  // A Society's planner can set the threshold as a share of the window; the sidebar shows that share as it is.
  const [thresholdShare, setThresholdShare] = createSignal<string | undefined>(undefined)

  createEffect(() => {
    const sessionMeta = (session() as any)?.metadata?.compaction_threshold
    const window = state()?.limit
    const parsed = parseThresholdValue(sessionMeta)
    if (parsed) {
      if (parsed.type === "percent") {
        setThresholdShare(`${parsed.percent}%`)
        if (window && window > 0) {
          setThreshold(Math.max(1, Math.round((window * parsed.percent) / 100)))
        } else {
          setThreshold(0)
        }
        return
      }
      if (parsed.type === "capped") {
        setThresholdShare(`${parsed.percent}%`)
        if (window && window > 0) {
          const share = Math.max(1, Math.round((window * parsed.percent) / 100))
          setThreshold(Math.min(share, parsed.tokens))
        } else {
          setThreshold(parsed.tokens)
        }
        return
      }
      if (parsed.type === "tokens") {
        setThresholdShare(undefined)
        setThreshold(parsed.tokens)
        return
      }
    }
    setThresholdShare(undefined)
    const def = extractServerCompactionThreshold(serverConfig())
    if (def !== undefined && def > 0) {
      setThreshold(def)
    } else {
      setThreshold(0)
    }
  })

  const displayThreshold = () => {
    const share = thresholdShare()
    const tokens = threshold()
    if (tokens <= 0) {
      return share ?? thresholdLabel(0)
    }
    if (share) {
      return `${share} (${thresholdLabel(tokens)})`
    }
    return thresholdLabel(tokens)
  }

  async function handleCompactionPrompt() {
    const dialog = props.context.ui?.dialog
    if (!dialog) return

    const currentFormatted =
      thresholdShare() ??
      (threshold() > 0 ? (threshold() >= 1000 ? `${threshold() / 1000}k` : String(threshold())) : "0")

    const input = await dialog.prompt({
      title: t("Context auto-compaction threshold"),
      placeholder: t("e.g.: 400k, 200000, 60%, 80k or 0 for context limit"),
      value: currentFormatted,
    })

    if (input === undefined) return
    const parsed = parseThresholdValue(input)
    if (parsed === undefined) return

    const window = state()?.limit
    let valueToSave: unknown
    let effectiveTokens = 0

    if (parsed.type === "tokens") {
      valueToSave = parsed.tokens
      effectiveTokens = parsed.tokens
      setThreshold(parsed.tokens)
      setThresholdShare(undefined)
    } else if (parsed.type === "percent") {
      valueToSave = `${parsed.percent}%`
      effectiveTokens = window && window > 0 ? Math.max(1, Math.round((window * parsed.percent) / 100)) : 0
      setThresholdShare(`${parsed.percent}%`)
      setThreshold(effectiveTokens)
    } else if (parsed.type === "capped") {
      valueToSave = { percent: parsed.percent, tokens: parsed.tokens }
      effectiveTokens =
        window && window > 0
          ? Math.min(Math.max(1, Math.round((window * parsed.percent) / 100)), parsed.tokens)
          : parsed.tokens
      setThresholdShare(`${parsed.percent}%`)
      setThreshold(effectiveTokens)
    }

    try {
      if (props.context.client?.session?.update) {
        await (props.context.client.session.update as any)({
          sessionID: props.sessionID,
          metadata: { compaction_threshold: valueToSave },
        })
      } else if (client?.api?.session?.update) {
        await (client.api.session.update as any)({
          sessionID: props.sessionID,
          metadata: { compaction_threshold: valueToSave },
        })
      }
    } catch {
      // Ignore session update error in test environments
    }

    if (effectiveTokens > 0) {
      const makeDefault = await dialog.confirm({
        title: t("Auto-compaction threshold"),
        message: t("Make this threshold the default for all new chats on creation?"),
      })

      if (makeDefault) {
        // The server config is the one writer; the file is the fallback for a failed write. A save that
        // reached either of them is reported as success, however it landed.
        const saved = (await writeDefault(effectiveTokens).catch(() => false)) || (await saveDirectFallback(effectiveTokens))
        await refetch()
        toast?.show(
          saved
            ? {
                variant: "success",
                message: t("Auto-compaction threshold ({threshold}) saved to configuration", {
                  threshold: thresholdLabel(effectiveTokens),
                }),
              }
            : { variant: "error", message: t("Failed to update configuration") },
        )
      }
    }
  }

  // The default belongs to the server's config; the caller falls back to the file when this throws
  // or when no client can write at all.
  async function writeDefault(threshold: number) {
    if (props.context.client?.config?.update) {
      await (props.context.client.config.update as any)({
        compaction: { threshold },
      })
      return true
    }
    if (client?.api?.config?.update) {
      await (client.api.config.update as any)({
        compaction: { threshold },
      })
      return true
    }
    return false
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
      <box gap={0} minWidth={0} onSizeChange={function () { setMeasuredWidth(this.width) }}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <b>{t("Context")}</b>
          </text>
          <Show when={scope() === "session" && state()?.percent}>
            {(percent) => <text fg={level(percent())}>{t("{percent}% used", { percent: percent() })}</text>}
          </Show>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={shownScopes()}>
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
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={theme.text.muted} wrapMode="none">
              {t("Auto-compaction at:")}
            </text>
            <HoverAction id="sidebar.context.compaction" onClick={handleCompactionPrompt}>
              <text fg={theme.text.base} wrapMode="none">
                {displayThreshold()} ✎
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
        <Show when={scope() === "society" && scoped.latest?.state === "no-society"}>
          <text fg={theme.text.muted}>{t("This session's project is not in a Society.")}</text>
        </Show>
        <Show when={apiBalance.latest}>
          {(info) => (
            <box>
              <text fg={theme.text.muted} wrapMode="none">
                {t("API · Polza")}
              </text>
              <box flexDirection="row" justifyContent="space-between" gap={1}>
                <text fg={theme.text.base} wrapMode="none">
                  {t("{cost} available", { cost: formatRubles(info().available) })}
                </text>
                <text fg={theme.text.muted} wrapMode="none">
                  {t("{cost} spent", { cost: formatRubles(info().spent) })}
                </text>
              </box>
              <Show when={info().reserved > 0}>
                <text fg={theme.text.muted} wrapMode="none">
                  {t("{cost} reserved", { cost: formatRubles(info().reserved) })}
                </text>
              </Show>
            </box>
          )}
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
                <text height={1} flexShrink={0} wrapMode="none">
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
                      {t("{cost} spent", { cost: formatMoney(spent()) })}
                    </text>
                  </Show>
                </box>
                <For each={kinds.filter((kind) => item().tokens[kind.id] > 0)}>
                  {(kind) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.muted}>{kind.glyph}</text>
                      <text fg={theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
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
                    <text fg={theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
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
                    <text fg={theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
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
                  <box>
                    <text fg={theme.text.muted}>
                      {t(
                        scope() === "project"
                          ? "Sessions in this project"
                          : scope() === "society"
                            ? "Projects in this Society"
                            : "Projects in this group",
                      )}
                    </text>
                    <For each={entries().slice(0, MAX_ENTRIES)}>
                      {(entry) => (
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
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
            {t("{cost} spent", { cost: formatMoney(cost()) })}
          </text>
        </Show>
      </box>
    </>
  )
}

export default Plugin.define({
  id: "orchestra.sidebar.context",
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
