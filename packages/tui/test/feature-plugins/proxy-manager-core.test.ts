import { describe, expect, test } from "bun:test"
import { parseHttpProxyList, proxyUrl } from "../../src/feature-plugins/system/proxy-manager-core"

describe("public HTTP proxy list parsing", () => {
  test("accepts bare IPv4 endpoints and explicit HTTP URLs", () => {
    const result = parseHttpProxyList("# list\n192.0.2.10:8080\nhttp://198.51.100.20:3128\n", "fixture")
    expect(result.map((entry) => entry.id)).toEqual(["192.0.2.10:8080", "198.51.100.20:3128"])
    expect(result.every((entry) => entry.status === "unchecked")).toBe(true)
  })

  test("deduplicates entries and rejects malformed, non-HTTP and invalid ports", () => {
    const result = parseHttpProxyList(
      "192.0.2.10:8080\n192.0.2.10:8080\nsocks5://198.51.100.10:1080\n300.1.2.3:80\n192.0.2.11:70000\nexample.com:8080\n",
      "fixture",
    )
    expect(result.map((entry) => entry.id)).toEqual(["192.0.2.10:8080"])
  })

  test("formats an HTTP proxy URL", () => {
    expect(proxyUrl({ host: "192.0.2.10", port: 8080 })).toBe("http://192.0.2.10:8080")
  })
})
