import { expect, test } from "bun:test"
import { completedToolUpdate } from "../../src/acp/tool"

test("ACP tool images preserve parameters and reject malformed data URL headers", () => {
  const result = completedToolUpdate({
    toolCallId: "data-url-regression",
    toolName: "screenshot",
    cwd: process.cwd(),
    input: {},
    content: [
      { type: "file", uri: "data:image/png;;;charset=x;;base64,AQID", mime: "image/png" },
      { type: "file", uri: "data:image/png;" + ";".repeat(1000) + ",broken", mime: "image/png" },
    ],
  })
  expect(result.content).toEqual([{ type: "content", content: { type: "image", mimeType: "image/png", data: "AQID" } }])
})
