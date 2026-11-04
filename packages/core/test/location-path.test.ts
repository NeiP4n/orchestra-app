import { describe, expect, test } from "bun:test"
import { Location } from "@orchestra/core/location"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { AbsolutePath } from "@orchestra/core/schema"

// Path handling used by the recovery flow (Location.Ref canonicalization).
// The win32-specific branches in normalizePath/assertSafePath (drive-relative
// rejection, DOS device names, path.win32 normalization) are gated on
// process.platform === "win32" and therefore only execute on Windows hosts;
// they are covered by inspection here, not by these POSIX runs.
describe("location path normalization", () => {
  test("collapses duplicate separators, dot segments and trailing slashes", () => {
    expect(Location.normalizePath("/a//b/./c/")).toBe("/a/b/c")
    expect(Location.normalizePath("/a/b/../b")).toBe("/a/b")
  })

  test("canonical refs treat equivalent spellings as the same location", () => {
    const a = LocationServiceMap.canonical(Location.Ref.make({ directory: AbsolutePath.make("/tmp/project/") }))
    const b = LocationServiceMap.canonical(Location.Ref.make({ directory: AbsolutePath.make("/tmp//project") }))
    expect(a.directory).toBe(b.directory)
  })

  test("preserves spaces in directory names", () => {
    expect(Location.normalizePath("/tmp/my project/sub dir")).toBe("/tmp/my project/sub dir")
  })

  test("sanitizePath rejects empty and null-byte paths", () => {
    expect(() => Location.sanitizePath("")).toThrow("cannot be empty")
    expect(() => Location.sanitizePath("/tmp/a\0b")).toThrow("null-byte")
  })
})
