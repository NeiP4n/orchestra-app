import { expect, test } from "bun:test"
import { consoleSiblings, consoleTerminalID } from "../src/util/console-terminal"

const sessions = [
  { id: "ses_a", directory: "/p1" },
  { id: "ses_b", directory: "/p1" },
  { id: "ses_c", directory: "/p2" },
]
const pick = (sessionID: string, terminals: Record<string, string[]>, selected: Record<string, string | null> = {}) =>
  consoleTerminalID({
    sessionID,
    sessions,
    terminals: (id) => (terminals[id] ?? []).map((term) => ({ id: term })),
    selected: (id) => selected[id] ?? null,
  })

test("sessions of one project land on the same shell", () => {
  const terminals = { ses_b: ["pty_1"] }
  expect(pick("ses_a", terminals)).toBe("pty_1")
  expect(pick("ses_b", terminals)).toBe("pty_1")
})

test("another project does not reuse the shell", () => {
  expect(pick("ses_c", { ses_a: ["pty_1"] })).toBeUndefined()
})

test("the open session's own selected terminal wins", () => {
  expect(pick("ses_a", { ses_a: ["pty_0", "pty_2"], ses_b: ["pty_1"] }, { ses_a: "pty_2" })).toBe("pty_2")
})

test("siblings are chosen by id so every session agrees", () => {
  const terminals = { ses_b: ["pty_b"] }
  expect(pick("ses_a", terminals)).toBe(pick("ses_b", terminals))
})

test("siblings are the sessions of the same directory", () => {
  expect(consoleSiblings("ses_a", sessions)).toEqual(["ses_a", "ses_b"])
  expect(consoleSiblings("ses_x", sessions)).toEqual(["ses_x"])
})
