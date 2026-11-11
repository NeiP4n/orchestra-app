import { describe, expect, it } from "bun:test"
import { startOAuthListener } from "./server.ts"
import { ANTIGRAVITY_REDIRECT_URI } from "../constants.ts"

const callback = (query: string) => `${ANTIGRAVITY_REDIRECT_URI}${query}`

describe("startOAuthListener", () => {
  it("ignores stray requests and resolves on the real redirect", async () => {
    const listener = await startOAuthListener()
    try {
      const pending = listener.waitForCallback()
      expect((await fetch(callback(""))).status).toBe(404)
      expect((await fetch(new URL("/favicon.ico", ANTIGRAVITY_REDIRECT_URI))).status).toBe(404)
      expect((await fetch(callback("?code=abc&state=xyz"))).status).toBe(200)
      const url = await pending
      expect(url.searchParams.get("code")).toBe("abc")
      expect(url.searchParams.get("state")).toBe("xyz")
    } finally {
      await listener.close()
    }
  })

  it("delivers a rejected sign-in so the caller can report it", async () => {
    const listener = await startOAuthListener()
    try {
      const pending = listener.waitForCallback()
      await fetch(callback("?error=access_denied"))
      expect((await pending).searchParams.get("error")).toBe("access_denied")
    } finally {
      await listener.close()
    }
  })

  it("releases the port when closed so a retry can listen again", async () => {
    const first = await startOAuthListener()
    first.waitForCallback().catch(() => undefined)
    await first.close()
    const second = await startOAuthListener()
    second.waitForCallback().catch(() => undefined)
    await second.close()
  })
})


for (const success of [true, false]) it(`callback page waits for actual token exchange result (${success})`, async () => {
  const listener = await startOAuthListener({ deferResult: true })
  try {
    let received = false
    const response = fetch(callback("?code=deferred&state=expected")).then(result => { received = true; return result })
    await listener.waitForCallback()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toBe(false)
    listener.finish(success)
    const result = await response
    expect(result.status).toBe(success ? 200 : 400)
    const body = await result.text()
    expect(body.includes("You've successfully authenticated")).toBe(success)
    expect(body).not.toContain("deferred")
  } finally { await listener.close() }
})
