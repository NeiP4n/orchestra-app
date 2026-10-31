import { createSignal } from "solid-js"
import { configureExchangeRate, DEFAULT_EXCHANGE_RATE } from "./money"

// Polza.ai keeps the account's money itself: the balance endpoint reports what is left, what is
// reserved by running requests and what the account has spent in total. The chat shows those
// rubles beside the session's own spend, so the operator sees both the provider's bill and what
// this chat cost. The key is read from the server configuration; the TUI asks the provider once a
// minute and keeps the last answer through an outage.
export type Balance = {
  readonly amount: number
  readonly available: number
  readonly reserved: number
  readonly spent: number
}

export type Settings = {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly exchangeRate: number
}

const DEFAULT_BASE_URL = "https://polza.ai/api/v1"
const TTL = 60_000

const [balance, setBalance] = createSignal<Balance>()
export { balance as polzaBalance }

let checked = 0
let inFlight: Promise<Balance | undefined> | undefined

/** The Polza part of the server configuration: the key, the endpoint and the ruble rate. */
export function polzaSettings(entries: unknown): Settings {
  const settings =
    Array.isArray(entries)
      ? entries.reduce<Record<string, unknown> | undefined>((found, entry) => {
          if (!entry || typeof entry !== "object") return found
          if ((entry as { type?: unknown }).type !== "document") return found
          const providers = (entry as { info?: { providers?: unknown; provider?: unknown } }).info
          const table = providers?.providers ?? providers?.provider
          if (!table || typeof table !== "object") return found
          const polza = (table as Record<string, unknown>).polza
          if (!polza || typeof polza !== "object") return found
          const next = (polza as { settings?: unknown }).settings
          return next && typeof next === "object" ? { ...found, ...(next as Record<string, unknown>) } : found
        }, undefined)
      : undefined
  const read = (key: string) => (typeof settings?.[key] === "string" ? (settings[key] as string) : undefined)
  const rate = typeof settings?.exchangeRate === "number" ? settings.exchangeRate : undefined
  return {
    apiKey: read("apiKey") ?? process.env.POLZA_API_KEY,
    baseURL: read("baseURL"),
    exchangeRate: rate ?? DEFAULT_EXCHANGE_RATE,
  }
}

/** Reads the balance for the configured key, at most once a minute. */
export async function syncPolza(settings: Settings): Promise<Balance | undefined> {
  configureExchangeRate(settings.exchangeRate)
  if (!settings.apiKey) return balance()
  if (inFlight) return inFlight
  if (Date.now() - checked < TTL) return balance()
  checked = Date.now()
  inFlight = read(settings).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function read(settings: Settings): Promise<Balance | undefined> {
  try {
    const response = await fetch(endpoint(settings.baseURL), {
      headers: { authorization: `Bearer ${settings.apiKey}`, accept: "application/json" },
    })
    if (!response.ok) return balance()
    const body = (await response.json()) as Record<string, unknown>
    const number = (value: unknown) => {
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
      return Number.isFinite(parsed) ? parsed : 0
    }
    const next = {
      amount: number(body.amount),
      available: number(body.available),
      reserved: number(body.reservedAmount),
      spent: number(body.spentAmount),
    }
    setBalance(next)
    return next
  } catch {
    return balance()
  }
}

function endpoint(baseURL: string | undefined) {
  const fallback = DEFAULT_BASE_URL
  try {
    const url = new URL(baseURL ?? fallback)
    url.pathname = "/api/v2/balance"
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return "https://polza.ai/api/v2/balance"
  }
}
