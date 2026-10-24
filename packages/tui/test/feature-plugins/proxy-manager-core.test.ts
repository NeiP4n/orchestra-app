import { describe, expect, test } from "bun:test"
import { OPENCODE_PROBE, PROXY_SOURCES, parseHttpProxyList, proxyUrl } from "../../src/feature-plugins/system/proxy-manager-core"

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


test("prioritizes a maintained HTTPS-capable proxy source", () => {
  expect(PROXY_SOURCES[0].name).toContain("HTTPS-verified")
  expect(PROXY_SOURCES[0].url).toContain("free-proxy-list/main/https.txt")
})

test("probes the actual OpenCode Zen model endpoint, not an unrelated health-check site", () => {
  expect(OPENCODE_PROBE).toEqual({ host: "opencode.ai", path: "/zen/v1/models" })
})
