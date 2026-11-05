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
      "http://foo.localhost/",
      "http://printer.local/",
    ]) {
      const exit = await Effect.runPromiseExit(Ssrf.assertPublicUrl(url))
      expect(exit._tag, url).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("Refusing to fetch")
    }
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
