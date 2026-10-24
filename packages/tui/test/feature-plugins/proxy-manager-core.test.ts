import { describe, expect, test } from "bun:test"
import { classifyZenProbe, OPENCODE_PROBE, PROXY_EGRESS_PROBE, PROXY_SOURCES, parseHttpProxyList, parseProxyExitIp, proxyUrl } from "../../src/feature-plugins/system/proxy-manager-core"

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


test("prioritizes the maintained HTTP proxy feed", () => {
  expect(PROXY_SOURCES[0].name).toBe("Proxifly HTTP")
  expect(PROXY_SOURCES[0].url).toContain("proxies/protocols/http/data.txt")
})

test("checks Zen reachability separately from verifying the public egress IP", () => {
  expect(OPENCODE_PROBE).toEqual({ host: "opencode.ai", path: "/zen/v1/models" })
  expect(PROXY_EGRESS_PROBE).toEqual({ host: "api.ipify.org", path: "/?format=json" })
})

test("parses a public egress IP from the ipify JSON response", () => {
  expect(parseProxyExitIp('{"ip":"203.0.113.10"}')).toBe("203.0.113.10")
  expect(parseProxyExitIp('{"ip":"not-an-ip"}')).toBeUndefined()
  expect(parseProxyExitIp('{"error":"bad response"}')).toBeUndefined()
})

test("does not mistake an unauthenticated Zen 401 for a dead proxy", () => {
  expect(classifyZenProbe(401, '{"error":"API key required"}')).toBe("healthy")
  expect(classifyZenProbe(200, '{"data":[]}')).toBe("healthy")
  expect(classifyZenProbe(503, '{"error":"temporarily unavailable"}')).toBe("dead")
})

test("marks an IP as Zen-limited only when the allowance response says so", () => {
  expect(classifyZenProbe(429, '{"error":"rate limited"}')).toBe("limited")
  expect(classifyZenProbe(403, '{"message":"Zen route forbidden"}')).toBe("dead")
  expect(classifyZenProbe(401, '{"error":"API key required"}')).not.toBe("limited")
})
