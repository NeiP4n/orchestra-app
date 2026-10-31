import { describe, expect, test } from "bun:test"
import { errorMessage } from "@orchestra/util/error"
import { errorMessage as fromBarrel } from "@orchestra/util/index"

describe("errorMessage", () => {
  test("reads an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  test("falls back to the error name when there is no message", () => {
    expect(errorMessage(new TypeError(""))).toBe("TypeError")
  })

  test("returns a thrown string as it is", () => {
    expect(errorMessage("plain failure")).toBe("plain failure")
  })

  test("reads an Effect failure object, including one that nests its message", () => {
    expect(errorMessage({ _tag: "FederationError", message: "No group named X" })).toBe("No group named X")
    expect(errorMessage({ _tag: "RpcError", data: { message: "The provider refused" } })).toBe("The provider refused")
  })

  test("prints null, undefined and primitives instead of throwing", () => {
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage(42)).toBe("42")
    expect(errorMessage(false)).toBe("false")
  })

  test("serializes a plain object that has no message", () => {
    expect(errorMessage({ code: 500, reason: "provider" })).toBe('{"code":500,"reason":"provider"}')
    expect(errorMessage({})).toBe("unknown error")
  })

  test("survives an object that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(errorMessage(cyclic)).toBe("unknown error")
  })

  test("the package barrel exposes the same function", () => {
    expect(fromBarrel).toBe(errorMessage)
  })
})
