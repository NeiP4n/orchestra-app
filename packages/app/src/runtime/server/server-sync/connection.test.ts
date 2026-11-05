import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createConnectionSync, reconnectOrder } from "./connection"

test("held directories refresh before the rest, otherwise keeping their order", () => {
  const held = new Set(["/b", "/d"])
  expect(reconnectOrder(["/a", "/b", "/c", "/d"], (directory) => held.has(directory))).toEqual(["/b", "/d", "/a", "/c"])
  expect(reconnectOrder(["/a", "/c"], (directory) => held.has(directory))).toEqual(["/a", "/c"])
})

test("a replay-gap resyncs like a reconnect", () => {
  const connected: Array<{ reconnect: boolean }> = []
  const sync = createRoot((dispose) => {
    const result = createConnectionSync({
      status: () => "connected",
      invalidate: () => {},
      connected: (info) => {
        connected.push(info)
      },
    })
    return { result, dispose }
  })
  sync.result.handleEvent({ type: "server.replay-gap" })
  expect(connected).toEqual([{ reconnect: true }])
  sync.dispose()
})
