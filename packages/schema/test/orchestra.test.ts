import { describe, expect, test } from "bun:test"
import { contains } from "../src/orchestra.js"

describe("Orchestra.contains directory matching", () => {
  test("handles case-insensitive Windows drive paths", () => {
    expect(contains("C:/Proj", "c:/proj/sub")).toBe(true)
    expect(contains("c:/proj", "C:/Proj/sub")).toBe(true)
    expect(contains("C:\\Proj", "c:/proj/sub")).toBe(true)
    expect(contains("C:/PROJ", "c:/proj")).toBe(true)
  })

  test("handles case-insensitive UNC network paths", () => {
    expect(contains("//Server/Share/Proj", "//server/share/proj/sub")).toBe(true)
    expect(contains("//srv/share", "//SRV/SHARE/sub")).toBe(true)
    expect(contains("//srv/share1", "//srv/share2/sub")).toBe(false)
  })

  test("collapses .. and prevents path traversal escapes", () => {
    expect(contains("C:/Proj", "C:/Proj/../evil")).toBe(false)
    expect(contains("C:/Proj", "C:/Proj/sub/../sub/file.txt")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/proj/../evil")).toBe(false)
  })

  test("handles standard Unix paths", () => {
    expect(contains("/home/user/proj", "/home/user/proj/sub")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/proj")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/other")).toBe(false)
  })
})
