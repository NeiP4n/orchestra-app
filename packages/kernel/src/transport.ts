// A Transport is any lawful way of getting a model answer: an API key, a signed-in subscription,
// a peer's shared quota, a local runtime, or a person. The kernel never asks which.
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ReadonlyArray<ToolCall> }
  | { role: "tool"; id: string; output: string }

export type ToolCall = { id: string; name: string; input: unknown }

export type Request = { messages: ReadonlyArray<Message>; system?: string }

export type Chunk =
  | { type: "text"; delta: string }
  | { type: "call"; call: ToolCall }

// Why a transport failed decides what the pool does next.
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: "rate-limit" | "unavailable" | "context-overflow" | "fatal",
    // Milliseconds until the transport may be tried again; only meaningful for rate-limit.
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

export type Transport = {
  readonly id: string
  send(request: Request, signal: AbortSignal): AsyncIterable<Chunk>
}

/**
 * Ordered failover over transports. A rate-limited or unavailable transport rests for a while and
 * the next one answers, so a quota running out never ends a session.
 */
export const pool = (transports: ReadonlyArray<Transport>, now: () => number = Date.now): Transport => {
  const resting = new Map<string, number>()
  return {
    id: `pool(${transports.map((transport) => transport.id).join(",")})`,
    async *send(request, signal) {
      const failures: Array<TransportError> = []
      for (const transport of transports) {
        if ((resting.get(transport.id) ?? 0) > now()) continue
        const emitted = { value: false }
        try {
          for await (const chunk of transport.send(request, signal)) {
            emitted.value = true
            yield chunk
          }
          return
        } catch (error) {
          if (!(error instanceof TransportError)) throw error
          // Once output reached the caller, switching transports would duplicate or splice answers.
          if (emitted.value || error.kind === "fatal" || error.kind === "context-overflow") throw error
          resting.set(transport.id, now() + (error.retryAfter ?? 30_000))
          failures.push(error)
        }
      }
      throw new TransportError(
        failures.length === 0 ? "every transport is resting" : failures.map((failure) => failure.message).join("; "),
        "unavailable",
        Math.min(...[...resting.values()].map((until) => until - now()), 30_000),
      )
    },
  }
}
