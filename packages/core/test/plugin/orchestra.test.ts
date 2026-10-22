import { describe, expect, it } from "bun:test"
import { reusableWorker } from "../../src/tool/plugin/orchestra"

type Access = "hidden" | "read" | "write" | "full"

const row = (id: string, role: string, access: Access) => ({
  role,
  access,
  session: { id, title: id },
})

describe("orchestra worker reuse", () => {
  it("reuses an idle writable session with the requested role", () => {
    const rows = [
      row("developer-busy", "developer", "full"),
      row("developer-free", "developer", "write"),
      row("tester-free", "tester", "full"),
    ]

    const result = reusableWorker(rows, "developer", new Set(["developer-busy"]))

    expect(result.matches.map((item) => item.session.id)).toEqual(["developer-busy", "developer-free"])
    expect(result.writable.map((item) => item.session.id)).toEqual(["developer-busy", "developer-free"])
    expect(result.session?.session.id).toBe("developer-free")
  })

  it("does not choose a read-only or different-role session", () => {
    const rows = [row("developer-read", "developer", "read"), row("tester-free", "tester", "full")]

    const result = reusableWorker(rows, "developer", new Set())

    expect(result.matches.map((item) => item.session.id)).toEqual(["developer-read"])
    expect(result.writable).toEqual([])
    expect(result.session).toBeUndefined()
  })

  it("returns no reusable worker when every matching worker has an outstanding task", () => {
    const rows = [row("developer-1", "developer", "full"), row("developer-2", "developer", "write")]

    const result = reusableWorker(rows, "developer", new Set(["developer-1", "developer-2"]))

    expect(result.writable).toHaveLength(2)
    expect(result.session).toBeUndefined()
  })
})
