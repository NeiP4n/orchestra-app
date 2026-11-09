import { expect, test } from "bun:test"
import { BrowserWatch } from "@orchestra/core/browser/watch"
import { directionRows, liveShapeRows, RowElement } from "./fixture/browser-watch/rows"

test("the actual page script only reports positively incoming fixture DOM rows", () => {
  let now = 0
  let mutation: (records: Array<{ addedNodes: RowElement[] }>) => void = () => { throw new Error("Observer not installed") }
  let flush: () => void = () => { throw new Error("Flush not scheduled") }
  const sent: string[] = []
  class Observer {
    constructor(callback: typeof mutation) { mutation = callback }
    observe() {}
  }
  const window = { [BrowserWatch.BINDING]: (value: string) => sent.push(value) }
  const document = { documentElement: new RowElement(), title: "fixture chat", querySelector: () => null }
  new Function("window", "document", "Element", "MutationObserver", "Date", "setTimeout", BrowserWatch.script())(
    window, document, RowElement, Observer, { now: () => now }, (callback: () => void) => { flush = callback; return 1 },
  )
  now = 4000
  // Separate batches preserve the history-load gate (more than 8 rows).
  for (const row of [...directionRows(), ...liveShapeRows()]) {
    mutation([{ addedNodes: [row] }])
    flush()
  }
  const rows = sent.flatMap((value) => JSON.parse(value).items)
  expect(rows).toEqual([
    { chat: "fixture chat", text: "in by id", out: false },
    { chat: "fixture chat", text: "in by parent", out: false },
    { chat: "fixture chat", text: "in by attribute", out: false },
    { chat: "fixture chat", text: "in by direction", out: false },
    { chat: "fixture chat", text: "fixture message", out: false },
  ])
  const accepted = sent.flatMap((value) => BrowserWatch.accept("fixture", value, now, BrowserWatch.makeState()))
  expect(accepted.map((row) => row.text)).toEqual(["in by id", "in by parent", "in by attribute", "in by direction", "fixture message"])
})
