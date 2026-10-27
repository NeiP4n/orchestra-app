import { describe, expect, test } from "bun:test"
import {
  computeBackoff,
  createEventSource,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from "../src/event-source"

describe("Exponential Backoff & Jitter", () => {
  test("computes exact exponential backoff when jitter is disabled", () => {
    const opts = { initialDelayMs: 500, maxDelayMs: 10_000, factor: 2, jitter: false }
    expect(computeBackoff(0, opts)).toBe(500)
    expect(computeBackoff(1, opts)).toBe(1000)
    expect(computeBackoff(2, opts)).toBe(2000)
    expect(computeBackoff(3, opts)).toBe(4000)
    expect(computeBackoff(4, opts)).toBe(8000)
    expect(computeBackoff(5, opts)).toBe(10000)
    expect(computeBackoff(6, opts)).toBe(10000)
  })

  test("uses default 500ms base and 10s max", () => {
    expect(DEFAULT_INITIAL_DELAY_MS).toBe(500)
    expect(DEFAULT_MAX_DELAY_MS).toBe(10_000)
    const delay0 = computeBackoff(0, { jitter: false })
    const delay10 = computeBackoff(10, { jitter: false })
    expect(delay0).toBe(500)
    expect(delay10).toBe(10_000)
  })

  test("applies randomized jitter within [exponential / 2, exponential]", () => {
    const baseOpts = { initialDelayMs: 1000, maxDelayMs: 8000, factor: 2, jitter: true }

    // Test with deterministically mocked random values
    const minJitter = computeBackoff(2, { ...baseOpts, random: () => 0 })
    const midJitter = computeBackoff(2, { ...baseOpts, random: () => 0.5 })
    const maxJitter = computeBackoff(2, { ...baseOpts, random: () => 1 })

    // exponential for attempt 2 is 1000 * 4 = 4000
    // min should be 2000, mid should be 3000, max should be 4000
    expect(minJitter).toBe(2000)
    expect(midJitter).toBe(3000)
    expect(maxJitter).toBe(4000)
  })
})

describe("EventSource Reconnection & Last-Event-ID", () => {
  test("tracks lastEventID and forwards it on reconnection attempts", async () => {
    let connectionAttempts = 0
    const receivedLastEventIDs: Array<string | undefined> = []

    const subscription = createEventSource<{ id: string; type: string }>({
      initialDelayMs: 10,
      maxDelayMs: 50,
      jitter: false,
      connect: async ({ signal, lastEventID }) => {
        connectionAttempts += 1
        receivedLastEventIDs.push(lastEventID)

        if (connectionAttempts === 1) {
          // First attempt emits event 1 and 2, then simulates disconnection
          return {
            async *[Symbol.asyncIterator]() {
              yield { id: "evt_1", type: "message" }
              yield { id: "evt_2", type: "message" }
              // Connection drops
            },
          }
        }

        // Second attempt receives lastEventID "evt_2" and emits event 3
        return {
          async *[Symbol.asyncIterator]() {
            yield { id: "evt_3", type: "message" }
            // Keep connection open until signal
            while (!signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
          },
        }
      },
    })

    const collected: string[] = []
    for await (const event of subscription) {
      collected.push(event.id)
      if (collected.length === 3) {
        subscription.close()
        break
      }
    }

    expect(collected).toEqual(["evt_1", "evt_2", "evt_3"])
    expect(receivedLastEventIDs).toEqual([undefined, "evt_2"])
    expect(subscription.lastEventID()).toBe("evt_3")
    expect(subscription.status()).toBe("disconnected")
  })

  test("handles connection failures with exponential retry and clean shutdown", async () => {
    let attempts = 0
    const delays: number[] = []
    const statuses: string[] = []

    const subscription = createEventSource({
      initialDelayMs: 20,
      maxDelayMs: 100,
      factor: 2,
      jitter: false,
      onStatusChange: (status) => statuses.push(status),
      onError: (_err, attempt, delay) => {
        delays.push(delay)
      },
      connect: async () => {
        attempts += 1
        if (attempts < 3) {
          throw new Error(`Simulated network failure on attempt ${attempts}`)
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { id: "evt_recovered", type: "ok" }
          },
        }
      },
    })

    const items: any[] = []
    for await (const item of subscription) {
      items.push(item)
      subscription.close()
      break
    }

    expect(items).toEqual([{ id: "evt_recovered", type: "ok" }])
    expect(attempts).toBe(3)
    // Attempt 1 failed -> delay for attempt 0 backoff: 20ms
    // Attempt 2 failed -> delay for attempt 1 backoff: 40ms
    expect(delays).toEqual([20, 40])
    expect(statuses).toContain("reconnecting")
    expect(statuses).toContain("connected")
    expect(subscription.status()).toBe("disconnected")
  })
})
