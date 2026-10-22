import { describe, expect, test } from "bun:test"
import { run } from "../src/loop.js"
import type { Event } from "../src/loop.js"
import { TransportError, pool } from "../src/transport.js"
import type { Chunk, Request, Transport } from "../src/transport.js"

const scripted = (id: string, turns: ReadonlyArray<ReadonlyArray<Chunk> | TransportError>): Transport => {
  const index = { value: 0 }
  return {
    id,
    async *send(_request: Request) {
      const turn = turns[Math.min(index.value, turns.length - 1)] ?? []
      index.value += 1
      if (turn instanceof TransportError) throw turn
      yield* turn
    },
  }
}

const collect = async (events: AsyncGenerator<Event>) => {
  const all: Array<Event> = []
  for await (const event of events) all.push(event)
  return all
}

const text = (delta: string): Chunk => ({ type: "text", delta })
const call = (id: string, name = "echo", input: unknown = id): Chunk => ({ type: "call", call: { id, name, input } })
const echo = { name: "echo", run: async (input: unknown) => `echo:${String(input)}` }

describe("kernel loop", () => {
  test("runs far past any step ceiling and stops when the model stops calling tools", async () => {
    const turns = [...Array.from({ length: 500 }, (_, index) => [call(`c${index}`)]), [text("finished")]]
    const events = await collect(run({ transport: scripted("t", turns), tools: [echo], messages: [{ role: "user", text: "go" }] }))
    expect(events.filter((event) => event.type === "result")).toHaveLength(500)
    expect(events.at(-1)?.type).toBe("done")
  })

  test("runs the calls of one answer in parallel", async () => {
    const started = { value: 0, peak: 0 }
    const slow = {
      name: "slow",
      run: async () => {
        started.value += 1
        started.peak = Math.max(started.peak, started.value)
        await Bun.sleep(20)
        started.value -= 1
        return "ok"
      },
    }
    await collect(
      run({
        transport: scripted("t", [[call("a", "slow"), call("b", "slow"), call("c", "slow")], [text("done")]]),
        tools: [slow],
        messages: [],
      }),
    )
    expect(started.peak).toBe(3)
  })

  test("feeds tool failures back to the model instead of ending the session", async () => {
    const broken = { name: "broken", run: async () => Promise.reject(new Error("boom")) }
    const events = await collect(
      run({ transport: scripted("t", [[call("x", "broken")], [call("y", "missing")], [text("ok")]]), tools: [broken], messages: [] }),
    )
    expect(events.filter((event) => event.type === "result").map((event) => event.type === "result" && event.output)).toEqual([
      "error: boom",
      "error: unknown tool missing",
    ])
  })

  test("waits out a rate limit and retries the same transport", async () => {
    const waits: Array<number> = []
    const events = await collect(
      run({
        transport: scripted("t", [new TransportError("slow down", "rate-limit", 250), [text("hi")]]),
        tools: [],
        messages: [],
        sleep: async (ms) => void waits.push(ms),
      }),
    )
    expect(waits).toEqual([250])
    expect(events.some((event) => event.type === "wait")).toBe(true)
    expect(events.some((event) => event.type === "text")).toBe(true)
  })

  test("compacts history on context overflow and retries", async () => {
    const seen: Array<number> = []
    const transport: Transport = {
      id: "t",
      async *send(request) {
        seen.push(request.messages.length)
        if (request.messages.length > 1) throw new TransportError("too long", "context-overflow")
        yield text("fits")
      },
    }
    await collect(
      run({
        transport,
        tools: [],
        messages: [
          { role: "user", text: "a" },
          { role: "user", text: "b" },
        ],
        compact: async (messages) => messages.slice(-1),
      }),
    )
    expect(seen).toEqual([2, 1])
  })

  test("a fatal failure ends the session", async () => {
    const failing = run({ transport: scripted("t", [new TransportError("bad key", "fatal")]), tools: [], messages: [] })
    await expect(collect(failing)).rejects.toThrow("bad key")
  })

  test("aborting stops before the next answer", async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(run({ transport: scripted("t", [[text("never")]]), tools: [], messages: [], signal: controller.signal }))
    expect(events.map((event) => event.type)).toEqual(["done"])
  })
})

describe("transport pool", () => {
  test("fails over to the next transport when one is rate limited", async () => {
    const first = scripted("first", [new TransportError("quota", "rate-limit", 1000)])
    const second = scripted("second", [[text("from second")]])
    const events = await collect(run({ transport: pool([first, second]), tools: [], messages: [] }))
    expect(events.find((event) => event.type === "text")).toEqual({ type: "text", delta: "from second" })
  })

  test("a resting transport is skipped until its time passes", async () => {
    const clock = { now: 0 }
    const used: Array<string> = []
    const make = (id: string, behavior: "limited" | "ok"): Transport => ({
      id,
      async *send() {
        used.push(id)
        if (behavior === "limited") throw new TransportError("quota", "rate-limit", 100)
        yield text(id)
      },
    })
    const combined = pool([make("a", "limited"), make("b", "ok")], () => clock.now)
    const drain = async () => {
      for await (const _ of combined.send({ messages: [] }, new AbortController().signal)) void _
    }
    await drain()
    await drain()
    expect(used).toEqual(["a", "b", "b"])
    clock.now = 200
    await drain()
    expect(used).toEqual(["a", "b", "b", "a", "b"])
  })

  test("never switches transports after output was already delivered", async () => {
    const half: Transport = {
      id: "half",
      async *send() {
        yield text("partial")
        throw new TransportError("dropped", "unavailable")
      },
    }
    const never = scripted("never", [[text("duplicate")]])
    const stream = pool([half, never]).send({ messages: [] }, new AbortController().signal)
    const seen: Array<string> = []
    await expect(
      (async () => {
        for await (const chunk of stream) if (chunk.type === "text") seen.push(chunk.delta)
      })(),
    ).rejects.toThrow("dropped")
    expect(seen).toEqual(["partial"])
  })
})
