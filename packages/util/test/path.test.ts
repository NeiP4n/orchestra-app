import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { comparablePath, containsDirectory, sameDirectory } from "../src/path.js"

describe("util/path: comparablePath and containsDirectory", () => {
  test("comparablePath collapses . and .. segments", () => {
    expect(comparablePath("C:/Proj/../evil")).toBe("C:/evil")
    expect(comparablePath("C:\\Proj\\sub\\..\\other")).toBe("C:/Proj/other")
    expect(comparablePath("C:/Proj/./sub")).toBe("C:/Proj/sub")
    expect(comparablePath("C:/")).toBe("C:/")
    expect(comparablePath("C:/..")).toBe("C:/")
    expect(comparablePath("/a/b/../c")).toBe("/a/c")
    expect(comparablePath("//server/share/dir/..")).toBe("//server/share")
    expect(comparablePath("\\\\server\\share\\dir\\..")).toBe("//server/share")
    expect(comparablePath("sub\\file.txt")).toBe("sub/file.txt")
    expect(comparablePath("dir\\..\\other")).toBe("other")
    expect(comparablePath("..\\evil")).toBe("../evil")
    expect(comparablePath("")).toBe("")
    expect(comparablePath("/")).toBe("/")
  })

  test("containsDirectory prevents traversal escapes via ..", () => {
    expect(containsDirectory("C:/Proj", "C:/Proj/../evil")).toBe(false)
    expect(containsDirectory("C:/Proj", "C:\\Proj\\..\\evil")).toBe(false)
    expect(containsDirectory("C:/Proj", "C:/Proj/..\\evil")).toBe(false)
    expect(containsDirectory("C:/Proj", "C:/Proj/sub/../sub/file.txt")).toBe(true)
    expect(containsDirectory("C:/Proj", "c:\\proj\\sub\\file.txt")).toBe(true)
    expect(containsDirectory("dir", "dir\\..\\evil")).toBe(false)
    expect(containsDirectory("dir", "dir\\sub\\..\\..\\evil")).toBe(false)
    expect(containsDirectory("dir", "dir\\sub\\file.txt")).toBe(true)
    expect(containsDirectory("/var/app", "/var/app/../etc/passwd")).toBe(false)
    expect(containsDirectory("/var/app", "/var/app/src/../src/index.ts")).toBe(true)
  })

  test("containsDirectory supports case-insensitive Windows and UNC paths", () => {
    expect(containsDirectory("C:/Proj", "c:/proj/sub")).toBe(true)
    expect(containsDirectory("c:/proj", "C:/Proj/sub")).toBe(true)
    expect(containsDirectory("C:/Proj", "C:/proj")).toBe(true)
    expect(containsDirectory("c:/proj", "C:/PROJ/sub/file.txt")).toBe(true)
    expect(containsDirectory("c:/proj", "C:/PROJ")).toBe(true)
    expect(containsDirectory("C:/Proj/Sub", "c:/proj")).toBe(false)
    expect(containsDirectory("//Server/Share/Dir", "//server/share/dir/sub")).toBe(true)
  })

  test("sameDirectory handles relative segments and casing", () => {
    expect(sameDirectory("C:/Proj/../Proj/sub", "c:/proj/sub")).toBe(true)
    expect(sameDirectory("c:/proj/sub", "C:/PROJ/SUB")).toBe(true)
    expect(sameDirectory("/app/./dir", "/app/dir")).toBe(true)
    expect(sameDirectory("C:/Proj", "C:/Other")).toBe(false)
  })

  test("comparablePath and containsDirectory canonicalize DOS 8.3 short names on Windows", () => {
    if (process.platform !== "win32") return
    if (!fs.existsSync("C:/PROGRA~1")) return

    expect(comparablePath("C:/PROGRA~1")).toBe("C:/Program Files")
    expect(containsDirectory("C:/Program Files", "C:/PROGRA~1/Common Files")).toBe(true)
    expect(containsDirectory("C:/PROGRA~1", "C:/Program Files/Common Files")).toBe(true)
    expect(sameDirectory("C:/PROGRA~1", "C:/Program Files")).toBe(true)
    expect(containsDirectory("C:/Program Files", "C:/PROGRA~1/../Windows")).toBe(false)
  })

  test("containsDirectory safely handles paths with tilde (~) and prevents traversal escape", () => {
    expect(comparablePath("C:/nonexistent/TEST~1")).toBe("C:/nonexistent/TEST~1")
    expect(containsDirectory("C:/nonexistent/TEST~1", "C:/nonexistent/TEST~1/sub")).toBe(true)
    expect(containsDirectory("C:/nonexistent/TEST~1", "C:/nonexistent/TEST~1/../evil")).toBe(false)
    expect(containsDirectory("C:/nonexistent/safe", "C:/nonexistent/safe/..~1/evil")).toBe(true)
    expect(containsDirectory("C:/nonexistent/safe", "C:/nonexistent/safe/../OTHER~1/evil")).toBe(false)
    expect(containsDirectory("C:/nonexistent/safe", "C:/nonexistent/safe/test~1/../../evil")).toBe(false)
    expect(containsDirectory("C:/nonexistent/test~1", "c:/nonexistent/TEST~1/sub")).toBe(true)
    expect(sameDirectory("C:/nonexistent/TEST~1", "c:/nonexistent/test~1")).toBe(true)
    expect(containsDirectory("C:/nonexistent/safe~1", "C:/nonexistent/other~1")).toBe(false)
  })

  test("containsDirectory and comparablePath handle Windows junctions and block sandbox breakout", () => {
    if (process.platform !== "win32") return

    const tempRoot = path.join(os.tmpdir(), `orchestra-test-junction-${Date.now()}`)
    const sandbox = path.join(tempRoot, "sandbox")
    const outside = path.join(tempRoot, "outside")
    const linkOut = path.join(sandbox, "link_out")
    const insideDir = path.join(sandbox, "inside")
    const linkIn = path.join(sandbox, "link_in")

    fs.mkdirSync(sandbox, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(insideDir, { recursive: true })

    try {
      fs.symlinkSync(outside, linkOut, "junction")
      fs.symlinkSync(insideDir, linkIn, "junction")

      const outsideTarget = path.join(linkOut, "secret.txt")
      const insideTarget = path.join(linkIn, "file.txt")

      expect(containsDirectory(sandbox, outsideTarget)).toBe(false)
      expect(containsDirectory(outside, outsideTarget)).toBe(true)
      expect(containsDirectory(sandbox, insideTarget)).toBe(true)
      expect(comparablePath(linkOut)).toBe(comparablePath(outside))
    } finally {
      try {
        fs.unlinkSync(linkOut)
      } catch {}
      try {
        fs.unlinkSync(linkIn)
      } catch {}
      try {
        fs.rmdirSync(insideDir)
      } catch {}
      try {
        fs.rmdirSync(sandbox)
      } catch {}
      try {
        fs.rmdirSync(outside)
      } catch {}
      try {
        fs.rmdirSync(tempRoot)
      } catch {}
    }
  })
})
