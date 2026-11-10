import { describe, expect, test } from "bun:test"
import { discoverModels, modelsURL, parseModels, reachable, validateBaseURL } from "../src/provider-discovery"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("validateBaseURL", () => {
  test("normalizes trailing slashes and rejects unsafe shapes", () => {
    expect(validateBaseURL("https://api.example.com/v1/")).toEqual({ ok: true, url: "https://api.example.com/v1" })
    expect(validateBaseURL("http://localhost:11434")).toEqual({ ok: true, url: "http://localhost:11434" })
    expect(validateBaseURL("ftp://x")).toMatchObject({ ok: false })
    expect(validateBaseURL("https://user:secret@api.example.com")).toMatchObject({ ok: false })
    expect(validateBaseURL("not a url")).toMatchObject({ ok: false })
    expect(validateBaseURL("")).toMatchObject({ ok: false })
  })

  test("joins the models path exactly once", () => {
    expect(modelsURL("https://x/v1")).toBe("https://x/v1/models")
    expect(modelsURL("https://x/v1/models")).toBe("https://x/v1/models")
  })
})

describe("parseModels", () => {
  test("accepts the OpenAI shape, wrappers and bare arrays; dedupes by id", () => {
    expect(parseModels({ data: [{ id: "a" }, { id: "b", name: "Bee" }, { id: "a" }] })).toEqual([
      { id: "a" },
      { id: "b", name: "Bee" },
    ])
    expect(parseModels({ models: ["x", { id: "y" }] })).toEqual([{ id: "x" }, { id: "y" }])
    expect(parseModels(["only"])).toEqual([{ id: "only" }])
    expect(parseModels({ data: [{ name: "no id" }, 42, null] })).toEqual([])
    expect(parseModels({ unrelated: true })).toBeUndefined()
    expect(parseModels("nope")).toBeUndefined()
  })
})

// The injected fetch is fake, but the SSRF gate is real: use public IP literals so
// the unit fixtures neither resolve nonexistent domains nor depend on external DNS.
describe("discoverModels", () => {
  test("returns models and sends the key as a bearer header", async () => {
    let seen: RequestInit | undefined
    const result = await discoverModels({ baseURL: "https://8.8.8.8/v1", apiKey: "sk-secret" }, async (url, init) => {
      seen = init
      expect(url).toBe("https://8.8.8.8/v1/models")
      return json({ data: [{ id: "m1" }, { id: "m2" }] })
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.models.map((model) => model.id)).toEqual(["m1", "m2"])
    // fetchPublic hands the fetch a Headers instance, not the plain record.
    expect(new Headers(seen?.headers).get("authorization")).toBe("Bearer sk-secret")
  })

  test("classifies auth, unsupported and http failures without leaking the key", async () => {
    const auth = await discoverModels({ baseURL: "https://8.8.8.8", apiKey: "sk-secret" }, async () => json({}, 401))
    expect(auth).toMatchObject({ ok: false, error: { kind: "auth", status: 401 } })
    expect(JSON.stringify(auth)).not.toContain("sk-secret")
    expect(reachable(auth)).toBe(true)

    const unsupported = await discoverModels({ baseURL: "https://8.8.8.8" }, async () => json({}, 404))
    expect(unsupported).toMatchObject({ ok: false, error: { kind: "unsupported" } })
    expect(reachable(unsupported)).toBe(true)

    const http = await discoverModels({ baseURL: "https://8.8.8.8" }, async () => json({}, 500))
    expect(http).toMatchObject({ ok: false, error: { kind: "http", status: 500 } })

    const weird = await discoverModels({ baseURL: "https://8.8.8.8" }, async () => json({ hello: "world" }))
    expect(weird).toMatchObject({ ok: false, error: { kind: "unsupported" } })
  })

  test("classifies network failures and timeouts, and short-circuits invalid URLs", async () => {
    const network = await discoverModels({ baseURL: "https://8.8.8.8" }, async () => {
      throw new TypeError("fetch failed")
    })
    expect(network).toMatchObject({ ok: false, error: { kind: "network" } })
    expect(reachable(network)).toBe(false)

    const timeout = await discoverModels({ baseURL: "https://8.8.8.8" }, async () => {
      throw new DOMException("timed out", "TimeoutError")
    })
    expect(timeout).toMatchObject({ ok: false, error: { kind: "timeout" } })

    let called = false
    const invalid = await discoverModels({ baseURL: "file:///etc/passwd" }, async () => {
      called = true
      return json({})
    })
    expect(invalid).toMatchObject({ ok: false, error: { kind: "invalid-url" } })
    expect(called).toBe(false)
  })

  test("follows a redirect to a public models URL", async () => {
    const seen: string[] = []
    const result = await discoverModels({ baseURL: "https://8.8.8.8/v1" }, async (url) => {
      seen.push(url)
      if (url === "https://8.8.8.8/v1/models")
        return new Response(null, { status: 302, headers: { location: "https://1.1.1.1/v1/models" } })
      return json({ data: [{ id: "m1" }] })
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.models.map((model) => model.id)).toEqual(["m1"])
    expect(seen).toEqual(["https://8.8.8.8/v1/models", "https://1.1.1.1/v1/models"])
  })

  test("refuses a redirect to a private address and never sends the key there", async () => {
    const seen: string[] = []
    const result = await discoverModels({ baseURL: "https://8.8.8.8/v1", apiKey: "sk-secret" }, async (url) => {
      seen.push(url)
      if (seen.length === 1)
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } })
      return json({ data: [{ id: "m1" }] })
    })
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid-url" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain("Refusing to fetch")
    expect(seen).toEqual(["https://8.8.8.8/v1/models"])
    expect(JSON.stringify(result)).not.toContain("sk-secret")
  })

  test("strips the key when a redirect crosses origins", async () => {
    const seenAuth: Array<string | null> = []
    const result = await discoverModels({ baseURL: "https://8.8.8.8/v1", apiKey: "sk-secret" }, async (url, init) => {
      seenAuth.push(new Headers(init.headers).get("authorization"))
      if (url === "https://8.8.8.8/v1/models")
        return new Response(null, { status: 302, headers: { location: "https://1.1.1.1/v1/models" } })
      return json({ data: [{ id: "m1" }] })
    })
    expect(result.ok).toBe(true)
    expect(seenAuth).toEqual(["Bearer sk-secret", null])
  })

  test("refuses a private or loopback base URL before the key is sent", async () => {
    for (const baseURL of [
      "http://169.254.169.254/",
      "http://127.0.0.1:17890/",
      "http://localhost:11434/",
      "http://10.0.0.5/v1",
      "http://192.168.1.10/v1",
    ]) {
      let called = false
      let seenHeaders: unknown
      const result = await discoverModels({ baseURL, apiKey: "sk-secret" }, async (_url, init) => {
        called = true
        seenHeaders = init?.headers
        return json({ data: [{ id: "m1" }] })
      })
      expect(result, baseURL).toMatchObject({ ok: false, error: { kind: "invalid-url" } })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain("Refusing to fetch")
      // The fetch never ran, so the saved key never left the process.
      expect(called, baseURL).toBe(false)
      expect(seenHeaders).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain("sk-secret")
    }
  })
})
