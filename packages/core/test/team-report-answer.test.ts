import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { finalAnswer } from "@orchestra/core/orchestra"

const assistant = (created: number, text: string | undefined, ...tools: Array<[string, Record<string, unknown>, string]>) =>
  ({
    type: "assistant",
    time: { created: DateTime.makeUnsafe(created) },
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map(([name, input, result]) => ({
        type: "tool",
        name,
        state: { status: "completed", input, content: [{ type: "text", text: result }] },
      })),
    ],
  }) as never

describe("a worker's task is never reported empty", () => {
  test("the last turn's text is the answer", () => {
    // Messages are newest first.
    const answer = finalAnswer([assistant(2, "DONE\nOpened muse.ai"), assistant(1, "Opening the page")])
    expect(answer).toEqual({ answer: "DONE\nOpened muse.ai", noFinal: false })
  })

  test("a turn that ended on tool calls says so, lists the last three calls and does not pass an earlier remark off as the result", () => {
    const answer = finalAnswer([
      assistant(
        3,
        undefined,
        ["browser", { action: "open", url: "https://muse.ai" }, "Opened"],
        ["browser", { action: "snapshot" }, "page: Muse"],
        ["browser", { action: "click", ref: "@e3" }, "Clicked"],
        ["browser", { action: "snapshot" }, "form shown"],
      ),
      assistant(1, "Now I will open the page"),
    ])
    expect(answer.noFinal).toBe(true)
    expect(answer.answer).toContain("NO FINAL ANSWER")
    expect(answer.answer).toContain("browser action=click ref=@e3 -> Clicked")
    expect(answer.answer).toContain("browser action=snapshot -> form shown")
    expect(answer.answer).not.toContain("url=https://muse.ai")
    expect(answer.answer).toContain("An earlier remark of the worker (not a result): Now I will open the page")
  })

  test("a worker with no text and no tool calls still gives a plain report", () => {
    const answer = finalAnswer([])
    expect(answer.noFinal).toBe(true)
    expect(answer.answer).toContain("It made no tool calls.")
  })
})
