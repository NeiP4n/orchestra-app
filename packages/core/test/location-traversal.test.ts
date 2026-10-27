import { describe, expect, test } from "bun:test"
import { FSUtil } from "@orchestra/util/fs-util"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Location } from "@orchestra/core/location"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { AbsolutePath } from "@orchestra/core/schema"

describe("Location path traversal and isolation", () => {
  describe("Location.assertSafePath / sanitizePath", () => {
    test("rejects empty paths", () => {
      expect(() => Location.assertSafePath("")).toThrow("cannot be empty")
      expect(() => Location.sanitizePath("")).toThrow("cannot be empty")
    })

    test("rejects null-byte traversal injections", () => {
      expect(() => Location.assertSafePath("/safe/path\0/evil")).toThrow("null-byte")
      expect(() => Location.sanitizePath("C:\\safe\\path\0\\evil")).toThrow("null-byte")
    })

    if (process.platform === "win32") {
      test("rejects Windows drive-relative paths without leading separator", () => {
        expect(() => Location.assertSafePath("C:relative/path")).toThrow("drive-relative")
        expect(() => Location.assertSafePath("D:unslashed")).toThrow("drive-relative")
      })

      test("rejects Windows reserved DOS device names in path segments", () => {
        expect(() => Location.assertSafePath("C:\\repo\\CON\\file.txt")).toThrow("reserved device name")
        expect(() => Location.assertSafePath("C:/repo/NUL/sub")).toThrow("reserved device name")
        expect(() => Location.assertSafePath("C:\\PRN")).toThrow("reserved device name")
      })

      test("normalizes valid Windows paths and eliminates traversal dots", () => {
        const safe = Location.sanitizePath("C:/projects/app/../app/src")
        expect(safe).toBe(AbsolutePath.make("C:\\projects\\app\\src"))
      })
    }

    test("normalizes POSIX-style paths and eliminates traversal dots", () => {
      const safe = Location.sanitizePath("/repo/packages/core/../core/src")
      expect(safe).toContain("core")
      expect(safe).not.toContain("..")
    })
  })

  describe("LocationServiceMap.canonical", () => {
    test("sanitizes and normalizes placement directory keys consistently", () => {
      const ref = Location.Ref.make({
        directory: AbsolutePath.make(process.platform === "win32" ? "C:/app/../app" : "/app/../app"),
      })
      const canonicalRef = LocationServiceMap.canonical(ref)
      expect(canonicalRef.directory).not.toContain("..")
      if (process.platform === "win32") {
        expect(canonicalRef.directory).toBe(AbsolutePath.make("C:\\app"))
      } else {
        expect(canonicalRef.directory).toBe(AbsolutePath.make("/app"))
      }
    })
  })

  describe("Orchestra.contains sandbox boundary isolation", () => {
    test("blocks traversal escapes trying to exit sandbox root", () => {
      expect(Orchestra.contains("/sandbox/repo", "/sandbox/repo/../outside")).toBe(false)
      expect(Orchestra.contains("/sandbox/repo", "/sandbox/repo/../../etc/passwd")).toBe(false)
      expect(Orchestra.contains("C:/sandbox/repo", "C:/sandbox/repo/../outside")).toBe(false)
      expect(Orchestra.contains("C:\\sandbox\\repo", "C:\\sandbox\\repo\\..\\outside")).toBe(false)
    })

    test("allows legitimate subdirectories with cross-platform slash variance", () => {
      expect(Orchestra.contains("/sandbox/repo", "/sandbox/repo/src")).toBe(true)
      expect(Orchestra.contains("C:/sandbox/repo", "C:/sandbox/repo/packages/core")).toBe(true)
      expect(Orchestra.contains("C:\\sandbox\\repo", "C:/sandbox/repo/packages/core")).toBe(true)
      expect(Orchestra.contains("C:/sandbox/repo", "C:\\sandbox\\repo\\packages\\core")).toBe(true)
    })

    test("recognizes identical root directory", () => {
      expect(Orchestra.contains("/sandbox/repo", "/sandbox/repo")).toBe(true)
      expect(Orchestra.contains("C:\\sandbox\\repo", "C:/sandbox/repo")).toBe(true)
    })
  })

  describe("FSUtil.contains cross-platform path isolation", () => {
    test("strictly rejects parent traversal escapes with both slash types", () => {
      expect(FSUtil.contains("/app/repo", "/app/outside")).toBe(false)
      expect(FSUtil.contains("/app/repo", "/app/repo/../outside")).toBe(false)
    })
  })
})
