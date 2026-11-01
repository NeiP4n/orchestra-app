import { describe, expect, test } from "bun:test"
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
    expect(containsDirectory("//Server/Share/Dir", "//server/share/dir/sub")).toBe(true)
  })

  test("sameDirectory handles relative segments and casing", () => {
    expect(sameDirectory("C:/Proj/../Proj/sub", "c:/proj/sub")).toBe(true)
    expect(sameDirectory("/app/./dir", "/app/dir")).toBe(true)
    expect(sameDirectory("C:/Proj", "C:/Other")).toBe(false)
  })
})
