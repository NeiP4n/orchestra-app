import { expect, test } from "bun:test"
import { connectURL, decide, type LocalService } from "../src/service-probe"

const protocolError =
  "Background service uses an incompatible health protocol. Update this client or explicitly restart the service."

function service(input: Pick<LocalService, "state" | "compatible" | "version">) {
  return {
    info: { url: "http://127.0.0.1:4096", pid: 4242, version: input.version },
    endpoint: { url: "http://127.0.0.1:4096" },
    ...input,
  } satisfies LocalService
}

test("a missing health endpoint fails unless the caller requires a different version", () => {
  const missing = service({ version: "2.0.0", state: "ready", compatible: false })
  expect(decide(missing, {})).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: "2.0.0" })).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: (version) => version.startsWith("2.") })).toEqual({
    _tag: "fail",
    error: new Error(protocolError),
  })
  expect(decide(missing, { version: "3.0.0" })).toEqual({ _tag: "replace", pty: "handoff" })
  expect(decide(service({ state: "ready", compatible: false }), { version: "3.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
})

test("a compatible service is reused when ready, awaited while starting, and replaced when it failed", () => {
  expect(decide(service({ version: "2.0.0", state: "ready", compatible: true }), {})).toEqual({ _tag: "reuse" })
  expect(decide(service({ version: "2.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "wait",
  })
  expect(decide(service({ version: "2.0.0", state: "failed", compatible: true }), {})).toEqual({
    _tag: "replace",
    pty: "clear",
  })
})

test("a version mismatch replaces the service, handing off terminals only when it is ready", () => {
  expect(decide(service({ version: "1.0.0", state: "ready", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
  expect(decide(service({ version: "1.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
  expect(decide(service({ version: "1.0.0", state: "failed", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
})

test("connectURL rewrites a wildcard bind address to loopback and leaves connectable URLs alone", () => {
  // A LAN-open service registers its wildcard bind address; Windows clients
  // cannot connect to 0.0.0.0, so discovery must dial loopback instead.
  expect(connectURL("http://0.0.0.0:49375")).toBe("http://127.0.0.1:49375")
  expect(connectURL("http://[::]:49375")).toBe("http://127.0.0.1:49375")
  expect(connectURL("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096")
  expect(connectURL("http://192.168.1.10:4096")).toBe("http://192.168.1.10:4096")
  expect(connectURL("https://example.com:4096")).toBe("https://example.com:4096")
})
