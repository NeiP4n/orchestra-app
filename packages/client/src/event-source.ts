export * as EventSourceClient from "./event-source.js"

export type EventSourceConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected"

export interface BackoffOptions {
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly factor?: number
  readonly jitter?: boolean
  readonly random?: () => number
}

export const DEFAULT_INITIAL_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 10_000
export const DEFAULT_BACKOFF_FACTOR = 2

/**
 * Computes backoff duration with exponential increase and randomized jitter.
 * When jitter is enabled (default), uses Equal Jitter to ensure a healthy base
 * while preventing thundering herd across re-connecting clients.
 */
export function computeBackoff(attempt: number, options?: BackoffOptions): number {
  const initial = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const max = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const factor = options?.factor ?? DEFAULT_BACKOFF_FACTOR
  const rand = options?.random ?? Math.random

  const exponential = Math.min(max, initial * Math.pow(factor, Math.max(0, attempt)))

  if (options?.jitter === false) {
    return exponential
  }

  // Equal jitter: 50% deterministic base + 50% randomized jitter
  const half = exponential / 2
  return Math.round(half + rand() * half)
}

export interface EventSourceConnectParams {
  readonly signal: AbortSignal
  readonly lastEventID?: string
}

export interface EventSourceOptions<T = unknown> extends BackoffOptions {
  readonly url?: string | URL
  readonly connect?: (params: EventSourceConnectParams) => Promise<AsyncIterable<T>> | AsyncIterable<T>
  readonly headers?: Record<string, string>
  readonly initialLastEventID?: string
  readonly maxAttempts?: number
  readonly signal?: AbortSignal
  readonly onEvent?: (event: T) => void
  readonly onError?: (error: unknown, attempt: number, delayMs: number) => void
  readonly onStatusChange?: (status: EventSourceConnectionStatus, attempt: number) => void
}

export interface EventSourceSubscription<T> extends AsyncIterable<T> {
  readonly status: () => EventSourceConnectionStatus
  readonly lastEventID: () => string | undefined
  readonly close: () => void
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)

    function onAbort() {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Parses Server-Sent Events stream from a fetch Response.
 */
async function* parseSseStream<T>(response: Response, signal: AbortSignal): AsyncIterable<{ id?: string; data: T }> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentId: string | undefined

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const lines = block.split("\n")
        const dataLines: string[] = []

        for (const line of lines) {
          if (line.startsWith("id:")) {
            currentId = line.slice(3).trim()
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart())
          }
        }

        if (dataLines.length > 0) {
          const raw = dataLines.join("\n")
          let parsed: any = raw
          try {
            parsed = JSON.parse(raw)
          } catch {}
          yield { id: currentId, data: parsed as T }
        }

        boundary = buffer.indexOf("\n\n")
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
    reader.releaseLock()
  }
}

export function createEventSource<T = unknown>(options: EventSourceOptions<T>): EventSourceSubscription<T> {
  let status: EventSourceConnectionStatus = "connecting"
  let lastEventID: string | undefined = options.initialLastEventID
  let closed = false
  let currentAbortController: AbortController | undefined

  const rootAbort = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) {
      closed = true
      status = "disconnected"
    } else {
      options.signal.addEventListener("abort", () => close(), { once: true })
    }
  }

  const queue: T[] = []
  const pendingRequests: Array<{
    resolve: (res: IteratorResult<T>) => void
    reject: (err: any) => void
  }> = []

  function setStatus(next: EventSourceConnectionStatus, attempt: number) {
    if (status === next) return
    status = next
    options.onStatusChange?.(next, attempt)
  }

  function pushItem(item: T) {
    if (closed) return
    options.onEvent?.(item)
    const pending = pendingRequests.shift()
    if (pending) {
      pending.resolve({ done: false, value: item })
    } else {
      queue.push(item)
    }
  }

  function close() {
    if (closed) return
    closed = true
    setStatus("disconnected", 0)
    rootAbort.abort()
    currentAbortController?.abort()
    while (pendingRequests.length > 0) {
      const p = pendingRequests.shift()
      p?.resolve({ done: true, value: undefined })
    }
    queue.length = 0
  }

  async function runLoop() {
    let attempt = 0

    while (!closed && !rootAbort.signal.aborted) {
      if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) {
        close()
        break
      }

      setStatus(attempt === 0 ? "connecting" : "reconnecting", attempt)
      const attemptController = new AbortController()
      currentAbortController = attemptController

      const onRootAbort = () => attemptController.abort()
      rootAbort.signal.addEventListener("abort", onRootAbort, { once: true })

      try {
        let stream: AsyncIterable<T>

        if (options.connect) {
          stream = await options.connect({
            signal: attemptController.signal,
            lastEventID,
          })
        } else if (options.url) {
          const headers = new Headers(options.headers)
          headers.set("Accept", "text/event-stream")
          if (lastEventID) {
            headers.set("Last-Event-ID", lastEventID)
          }

          const targetUrl = new URL(options.url.toString())
          if (lastEventID && !targetUrl.searchParams.has("lastEventID")) {
            targetUrl.searchParams.set("lastEventID", lastEventID)
          }

          const response = await fetch(targetUrl.toString(), {
            headers,
            signal: attemptController.signal,
          })

          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`)
          }

          const parsedStream = parseSseStream<T>(response, attemptController.signal)
          stream = {
            async *[Symbol.asyncIterator]() {
              for await (const chunk of parsedStream) {
                if (chunk.id) lastEventID = chunk.id
                yield chunk.data
              }
            },
          }
        } else {
          throw new Error("createEventSource requires either 'connect' or 'url' option")
        }

        let first = true
        for await (const item of stream) {
          if (closed || attemptController.signal.aborted) break
          if (first) {
            first = false
            attempt = 0
            setStatus("connected", 0)
          }

          // Extract event id if present in object
          if (item && typeof item === "object" && "id" in item && typeof (item as any).id === "string") {
            lastEventID = (item as any).id
          }

          pushItem(item)
        }

        if (closed || rootAbort.signal.aborted) break
        // If stream ended cleanly without error, reconnect
      } catch (err) {
        if (closed || rootAbort.signal.aborted) break
        attempt += 1
        const delay = computeBackoff(attempt - 1, options)
        options.onError?.(err, attempt, delay)
        setStatus("reconnecting", attempt)
        await wait(delay, rootAbort.signal)
        continue
      } finally {
        rootAbort.signal.removeEventListener("abort", onRootAbort)
        attemptController.abort()
        if (currentAbortController === attemptController) {
          currentAbortController = undefined
        }
      }

      // If stream ended without error, back off lightly
      attempt += 1
      const delay = computeBackoff(attempt - 1, options)
      setStatus("reconnecting", attempt)
      await wait(delay, rootAbort.signal)
    }
  }

  // Start background reconnection loop without unhandled rejection
  runLoop().catch(() => close())

  return {
    status: () => status,
    lastEventID: () => lastEventID,
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            const val = queue.shift()!
            return Promise.resolve({ done: false, value: val })
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined })
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            pendingRequests.push({ resolve, reject })
          })
        },
        return(): Promise<IteratorResult<T>> {
          close()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
