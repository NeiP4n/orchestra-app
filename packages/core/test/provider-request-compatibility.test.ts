import { describe, expect, test } from "bun:test"
import { prepare } from "@orchestra/core/provider-request-compatibility"

const tool = (name: string) => ({
  type: "tool" as const,
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
})

describe("provider request compatibility", () => {
  test("leaves tools and toolChoice untouched", () => {
    const tools = [tool("read")]
    expect(prepare({ providerID: "anthropic", tools, toolChoice: "auto" })).toEqual({
      tools,
      toolChoice: "auto",
    })
    expect(prepare({ providerID: "opencode", tools, toolChoice: "auto" })).toEqual({
      tools,
      toolChoice: "auto",
    })
  })
})
