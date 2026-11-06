import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Ssrf } from "@orchestra/core/tool/ssrf"

describe("Ssrf.isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.12.34.56", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.10", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["224.0.0.1", true],
    ["240.0.0.1", true],
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.5", true],
    // T3-1: the IPv4 tail in hex form is the same address as the dotted form.
    ["::ffff:7f00:1", true],
    ["::ffff:7f00:0001", true],
    ["::7f00:1", true],
    ["::ffff:a9fe:a9fe", true],
    ["::a9fe:a9fe", true],
    ["::ffff:0a00:0001", true],
    ["64:ff9b::7f00:1", true],
    ["64:ff9b::a9fe:a9fe", true],
    ["100::1", true],
    ["::ffff:808:808", false],
    // A public IPv6 address whose last 32 bits merely look like a private
    // IPv4 address is still public: only IPv4-embedding prefixes carry a v4 tail.
    ["2606:4700:4700::1111", false],
    ["2001:4860:4860::a9fe", false],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.167.1.1", false],
    ["192.169.1.1", false],
    ["100.63.0.1", false],
    ["100.128.0.1", false],
    ["2001:4860:4860::8888", false],
    ["::ffff:8.8.8.8", false],
  ])("classifies %s as private=%s", (address, expected) => {
    expect(Ssrf.isPrivateAddress(address)).toBe(expected)
  })
})

describe("Ssrf.fetchPublic", () => {
  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } })

  test("follows same-origin and relative redirects to the final response", async () => {
    const seen: string[] = []
    const response = await Ssrf.fetchPublic({
      url: "https://8.8.8.8/v1",
      fetchFn: async (url) => {
        seen.push(url)
        if (url === "https://8.8.8.8/v1") return redirect("/v1/models")
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 })
      },
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual(["https://8.8.8.8/v1", "https://8.8.8.8/v1/models"])
  })

  test("refuses a redirect to a private address and never fetches it", async () => {
    const seen: string[] = []
    await expect(
      Ssrf.fetchPublic({
        url: "https://8.8.8.8/v1",
        fetchFn: async (url) => {
          seen.push(url)
          if (seen.length === 1) return redirect("http://169.254.169.254/latest/meta-data/")
          return new Response("{}", { status: 200 })
        },
      }),
    ).rejects.toThrow("Refusing to fetch")
    expect(seen).toEqual(["https://8.8.8.8/v1"])
  })

  test("refuses a redirect to a hex-tail IPv6 loopback", async () => {
    await expect(
      Ssrf.fetchPublic({
        url: "https://8.8.8.8/v1",
        fetchFn: async (url) => {
          if (url === "https://8.8.8.8/v1") return redirect("http://[::ffff:7f00:1]/")
          return new Response("{}", { status: 200 })
        },
      }),
    ).rejects.toThrow("Refusing to fetch")
  })

  test("strips credentials on a cross-origin redirect and keeps them same-origin", async () => {
    const seenAuth: Array<string | null> = []
    await Ssrf.fetchPublic({
      url: "https://8.8.8.8/v1",
      headers: { authorization: "Bearer sk-secret", cookie: "session=abc" },
      fetchFn: async (url, init) => {
        seenAuth.push(new Headers(init.headers).get("authorization"))
        if (url === "https://8.8.8.8/v1") return redirect("https://1.1.1.1/v1")
        return new Response("{}", { status: 200 })
      },
    })
    expect(seenAuth).toEqual(["Bearer sk-secret", null])

    const kept: Array<string | null> = []
    await Ssrf.fetchPublic({
      url: "https://8.8.8.8/v1",
      headers: { authorization: "Bearer sk-secret" },
      fetchFn: async (url, init) => {
        kept.push(new Headers(init.headers).get("authorization"))
        if (url === "https://8.8.8.8/v1") return redirect("/v1/other")
        return new Response("{}", { status: 200 })
      },
    })
    expect(kept).toEqual(["Bearer sk-secret", "Bearer sk-secret"])
  })

  test("refuses to re-send a body to another origin and re-sends it same-origin", async () => {
    await expect(
      Ssrf.fetchPublic({
        url: "https://8.8.8.8/token",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_secret: "shh" }),
        fetchFn: async (url) => {
          if (url === "https://8.8.8.8/token") return redirect("https://1.1.1.1/token", 307)
          return new Response("{}", { status: 200 })
        },
      }),
    ).rejects.toThrow("Refusing to follow a redirect")

    const bodies: Array<unknown> = []
    await Ssrf.fetchPublic({
      url: "https://8.8.8.8/token",
      method: "POST",
      body: "grant_type=refresh_token",
      fetchFn: async (url, init) => {
        bodies.push(init.body)
        if (url === "https://8.8.8.8/token") return redirect("/token2", 307)
        return new Response("{}", { status: 200 })
      },
    })
    expect(bodies).toEqual(["grant_type=refresh_token", "grant_type=refresh_token"])
  })

  test("turns a 303 POST into a GET without a body", async () => {
    const seen: Array<{ method?: string; body: unknown }> = []
    await Ssrf.fetchPublic({
      url: "https://8.8.8.8/submit",
      method: "POST",
      body: "payload",
      fetchFn: async (url, init) => {
        seen.push({ method: init.method, body: init.body })
        if (url === "https://8.8.8.8/submit") return redirect("/done", 303)
        return new Response("{}", { status: 200 })
      },
    })
    expect(seen).toEqual([
      { method: "POST", body: "payload" },
      { method: "GET", body: undefined },
    ])
  })

  test("stops after the redirect limit and refuses a private first URL without fetching", async () => {
    await expect(
      Ssrf.fetchPublic({
        url: "https://8.8.8.8/loop",
        fetchFn: async () => redirect("/loop"),
      }),
    ).rejects.toThrow("Too many redirects")
    let called = false
    await expect(
      Ssrf.fetchPublic({
        url: "http://169.254.169.254/",
        fetchFn: async () => {
          called = true
          return new Response("{}", { status: 200 })
        },
      }),
    ).rejects.toThrow("Refusing to fetch")
    expect(called).toBe(false)
  })
})

describe("Ssrf.assertPublicUrlPromise", () => {
  test("refuses a private URL and allows a public one, like the Effect", async () => {
    await expect(Ssrf.assertPublicUrlPromise("http://169.254.169.254/")).rejects.toThrow("Refusing to fetch")
    await expect(Ssrf.assertPublicUrlPromise("http://127.0.0.1:17890/")).rejects.toThrow(
      "private or loopback address",
    )
    expect((await Ssrf.assertPublicUrlPromise("https://example.com/")).hostname).toBe("example.com")
  })
})

describe("Ssrf.assertPublicLiteralUrl", () => {
  test("refuses local hostnames and literal private IPs without a DNS lookup", () => {
    for (const url of [
      "http://localhost/",
      "http://127.0.0.1:9000/",
      "http://10.0.0.5/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://printer.local/",
    ]) {
      expect(() => Ssrf.assertPublicLiteralUrl(url), url).toThrow("Refusing to fetch")
    }
    expect(() => Ssrf.assertPublicLiteralUrl("file:///etc/passwd")).toThrow("http:// or https://")
    expect(() => Ssrf.assertPublicLiteralUrl("not a url")).toThrow("not a valid URL")
  })

  test("allows public literals and hostnames it cannot judge without DNS", () => {
    expect(Ssrf.assertPublicLiteralUrl("https://1.1.1.1/").toString()).toBe("https://1.1.1.1/")
    expect(Ssrf.assertPublicLiteralUrl("https://example.com/v1").hostname).toBe("example.com")
  })
})

describe("Ssrf.assertPublicUrl", () => {
  test("refuses loopback, private and metadata addresses without touching the network", async () => {
    for (const url of [
      "http://localhost/private",
      "http://localhost:8080/",
      "http://127.0.0.1:9000/",
      "http://10.0.0.5/admin",
      "http://172.16.0.9/",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fe80::1]/",
      // T3-1: IPv6 literals with a hex IPv4 tail are loopback / metadata too.
      "http://[::ffff:7f00:1]/",
      "http://[::7f00:1]/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://foo.localhost/",
      "http://printer.local/",
    ]) {
      const exit = await Effect.runPromiseExit(Ssrf.assertPublicUrl(url))
      expect(exit._tag, url).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("Refusing to fetch")
    }
  })

  test("allows a public IPv6 literal whose tail merely looks like a private IPv4", async () => {
    expect((await Effect.runPromise(Ssrf.assertPublicUrl("http://[::ffff:808:808]/"))).hostname).toBe("[::ffff:808:808]")
    expect((await Effect.runPromise(Ssrf.assertPublicUrl("https://[2606:4700:4700::1111]/"))).hostname).toBe(
      "[2606:4700:4700::1111]",
    )
  })

  test("refuses non-HTTP schemes", async () => {
    const exit = await Effect.runPromiseExit(Ssrf.assertPublicUrl("file:///etc/passwd"))
    expect(exit._tag).toBe("Failure")
  })

  test("allows a public literal IP and a public hostname", async () => {
    expect((await Effect.runPromise(Ssrf.assertPublicUrl("https://1.1.1.1/"))).toString()).toBe("https://1.1.1.1/")
    // The sandbox resolver answers public names; the check only needs the answer to be public.
    expect((await Effect.runPromise(Ssrf.assertPublicUrl("https://example.com/"))).hostname).toBe("example.com")
  })

  test("refuses a hostname that resolves to a loopback address", async () => {
    const exit = await Effect.runPromiseExit(Ssrf.assertPublicUrl("http://localhost/"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("local address")
  })
})
