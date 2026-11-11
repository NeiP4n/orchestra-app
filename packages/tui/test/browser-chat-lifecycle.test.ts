import { expect, test } from "bun:test"
import { browserChat, removeBrowserChat } from "../src/util/browser-chat-lifecycle"

test("only a typed missing response permits stale browser chat recovery and idempotent deletion", async () => {
  const missing = { _tag:"SessionNotFoundError",sessionID:"ses_missing",message:"Session not found" }
  expect(await browserChat(async()=>{throw missing})).toBeUndefined()
  await expect(removeBrowserChat(async()=>{throw missing})).resolves.toBeUndefined()
  const live={id:"ses_live"}
  expect(await browserChat(async()=>live)).toBe(live)
  for(const error of [new Error("offline"),{_tag:"UnauthorizedError"},{status:404},new Error("Session not found")]) {
    await expect(browserChat(async()=>{throw error})).rejects.toBe(error)
    await expect(removeBrowserChat(async()=>{throw error})).rejects.toBe(error)
  }
})
