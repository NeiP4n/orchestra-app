import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { describeUpstream, grantsUdp, parseUpstream, udpHeaderLength } from "@orchestra/core/warp-relay"
import { speaksHttp } from "@orchestra/core/warp"

describe("WARP relay upstream", () => {
  test("parses a pinned SOCKS5 upstream or direct", () => {
    expect(parseUpstream("socks5://127.0.0.1:7897")).toEqual({ kind: "socks5", host: "127.0.0.1", port: 7897 })
    expect(parseUpstream("direct")).toEqual({ kind: "direct" })
    expect(parseUpstream("http://127.0.0.1:7890")).toBeUndefined()
    expect(parseUpstream(undefined)).toBeUndefined()
  })

  test("describes upstreams for the diagnostic log", () => {
    expect(describeUpstream({ kind: "socks5", host: "127.0.0.1", port: 10808 })).toBe("socks5://127.0.0.1:10808")
    expect(describeUpstream({ kind: "direct" })).toBe("direct")
  })

  test("strips SOCKS5 UDP headers and drops fragments", () => {
    expect(udpHeaderLength(Buffer.from([0, 0, 0, 1, 1, 2, 3, 4, 0, 80, 9]))).toBe(10)
    expect(udpHeaderLength(Buffer.alloc(30, 0).fill(4, 3, 4))).toBe(22)
    expect(udpHeaderLength(Buffer.from([0, 0, 1, 1, 1, 2, 3, 4, 0, 80]))).toBe(0)
  })

  test("a port that is not a SOCKS5 server is not an upstream", async () => {
    const server = createServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    expect(await grantsUdp("127.0.0.1", port)).toBe(false)
    expect(await speaksHttp(port)).toBe(true)
    server.close()
  })
})

test("a server that closes a request silently does not speak HTTP", async () => {
  const server = createServer((socket) => socket.once("data", () => socket.destroy()))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  expect(await speaksHttp((server.address() as { port: number }).port)).toBe(false)
  server.close()
})
