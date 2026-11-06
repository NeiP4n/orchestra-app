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
