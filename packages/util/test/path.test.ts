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

  test("comparablePath keeps literal backslashes in POSIX-rooted paths and collapses slash-only roots", () => {
    // On win32 a slash-rooted path is valid current-drive syntax, so
    // backslashes there stay separators; off Windows they are literal.
    expect(comparablePath("/tmp/foo\\bar")).toBe(process.platform === "win32" ? "/tmp/foo/bar" : "/tmp/foo\\bar")
    expect(comparablePath("/tmp/demo///")).toBe("/tmp/demo")
    expect(comparablePath("/")).toBe("/")
    expect(comparablePath("//")).toBe("/")
    expect(comparablePath("///")).toBe("/")
    expect(comparablePath("///server")).toBe("/server")
    // Exactly two leading slashes followed by a name stay UNC.
    expect(comparablePath("//server/share")).toBe("//server/share")
    // Drive, UNC and relative forms still treat backslashes as separators.
    expect(comparablePath("C:\\tmp\\demo")).toBe("C:/tmp/demo")
    expect(comparablePath("\\\\server\\share")).toBe("//server/share")
    expect(comparablePath("sub\\file.txt")).toBe("sub/file.txt")
    expect(comparablePath("dir\\..\\other")).toBe("other")
    expect(comparablePath("..\\evil")).toBe("../evil")
  })

  test("on win32 slash-rooted paths keep separator semantics for backslashes", () => {
    if (process.platform !== "win32") return

    expect(comparablePath("/foo\\bar")).toBe("/foo/bar")
    expect(comparablePath("/foo/..\\outside")).toBe("/outside")
  })

  test("POSIX directories with literal backslashes keep a distinct identity from slash paths", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-"))
    const backslashDir = path.join(tempRoot, "a\\b")
    const slashDir = path.join(tempRoot, "a", "b")
    fs.mkdirSync(backslashDir)
    fs.mkdirSync(slashDir, { recursive: true })

    try {
      const root = comparablePath(tempRoot)
      const backslashKey = comparablePath(backslashDir)
      const slashKey = comparablePath(slashDir)

      expect(backslashKey).toBe(`${root}/a\\b`)
      expect(slashKey).toBe(`${root}/a/b`)
      expect(backslashKey).not.toBe(slashKey)
      expect(sameDirectory(backslashDir, slashDir)).toBe(false)
      expect(containsDirectory(tempRoot, backslashDir)).toBe(true)
      expect(containsDirectory(tempRoot, slashDir)).toBe(true)
      expect(containsDirectory(backslashDir, slashDir)).toBe(false)
      expect(containsDirectory(slashDir, backslashDir)).toBe(false)

      // A non-existing tail goes through walk-up canonicalization; the literal
      // backslash must survive there too.
      const missingBackslash = path.join(tempRoot, "missing\\tail")
      const missingSlash = path.join(tempRoot, "missing", "tail")
      expect(comparablePath(missingBackslash)).toBe(`${root}/missing\\tail`)
      expect(comparablePath(missingSlash)).toBe(`${root}/missing/tail`)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a POSIX symlink with a backslash in its name still canonicalizes through its target", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-link-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(outside)
    const link = path.join(inside, "link\\name")
    fs.symlinkSync(outside, link)

    try {
      expect(sameDirectory(link, outside)).toBe(true)
      expect(containsDirectory(inside, link)).toBe(false)

      // A missing tail under the link resolves against the target, then stays lexical.
      const missing = path.join(link, "missing")
      expect(comparablePath(missing)).toBe(`${comparablePath(outside)}/missing`)
      expect(containsDirectory(inside, missing)).toBe(false)
      expect(containsDirectory(outside, missing)).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a POSIX symlink with a relative target resolves against its own directory", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-rel-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(outside)
    const link = path.join(inside, "rel\\link")
    fs.symlinkSync("../outside", link)

    try {
      expect(sameDirectory(link, outside)).toBe(true)
      expect(containsDirectory(inside, link)).toBe(false)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a POSIX symlink target with .. resolves after following symlink segments inside it", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-hop-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(path.join(outside, "nested"), { recursive: true })
    fs.symlinkSync(path.join(outside, "nested"), path.join(inside, "hop"))
    const link = path.join(inside, "link\\name")
    // Relative target "hop/..": hop is itself a symlink, so the .. must apply
    // to the resolved outside/nested, landing on outside - not lexically on inside.
    fs.symlinkSync("hop/..", link)

    try {
      expect(sameDirectory(link, outside)).toBe(true)
      expect(containsDirectory(inside, link)).toBe(false)

      const missing = path.join(link, "missing")
      expect(comparablePath(missing)).toBe(`${comparablePath(outside)}/missing`)
      expect(containsDirectory(inside, missing)).toBe(false)
      expect(containsDirectory(outside, missing)).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a POSIX .. after a backslash-named symlink applies to the link's target", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-dotdot-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(path.join(outside, "nested"), { recursive: true })
    const link = path.join(inside, "link\\name")
    fs.symlinkSync(path.join(outside, "nested"), link)

    try {
      // The .. must not be collapsed lexically against the link's own name:
      // it applies after the symlink is followed, landing on outside.
      expect(comparablePath(`${link}/..`)).toBe(comparablePath(outside))
      expect(containsDirectory(inside, `${link}/..`)).toBe(false)

      const missing = `${link}/../missing`
      expect(comparablePath(missing)).toBe(`${comparablePath(outside)}/missing`)
      expect(containsDirectory(inside, missing)).toBe(false)
      expect(containsDirectory(outside, missing)).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a missing POSIX tail whose .. climbs back to a resolved prefix stays unresolved", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-missing-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(outside)
    const link = path.join(inside, "link\\name")
    fs.symlinkSync(outside, link)
    fs.writeFileSync(path.join(inside, "file.txt"), "x")

    try {
      // Native realpath reports ENOENT for the whole path, so the helper makes
      // no canonical claim and keeps the input unresolved.
      // Built by hand: path.join would lexically normalize the .. away.
      const climbing = `${inside}/missing/../link\\name`
      expect(comparablePath(climbing)).toBe(climbing)
      const throughFile = `${inside}/file.txt/x\\y`
      expect(comparablePath(throughFile)).toBe(throughFile)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("dangling POSIX symlink targets under literal-backslash links stay lexical", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-dangling-"))
    const inside = path.join(tempRoot, "inside")
    fs.mkdirSync(inside)
    const absolute = path.join(inside, "abs\\link")
    fs.symlinkSync(path.join(tempRoot, "no-such-target"), absolute)
    const relative = path.join(inside, "rel\\link")
    fs.symlinkSync("../gone", relative)

    try {
      expect(comparablePath(absolute)).toBe(`${comparablePath(tempRoot)}/no-such-target`)
      expect(comparablePath(relative)).toBe(`${comparablePath(tempRoot)}/gone`)
      expect(containsDirectory(inside, absolute)).toBe(false)
      expect(containsDirectory(inside, relative)).toBe(false)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("an existing file used with a trailing slash is kept literal, not validated as a directory", () => {
    if (process.platform === "win32") return

    // Characterization: comparablePath is a string identity helper, not a
    // filesystem validator; it does not check that a file-as-directory shape
    // really is a directory.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-file-"))
    const file = path.join(tempRoot, "fi\\le.txt")
    fs.writeFileSync(file, "x")

    try {
      expect(comparablePath(file)).toBe(`${comparablePath(tempRoot)}/fi\\le.txt`)
      expect(comparablePath(`${file}/`)).toBe(`${comparablePath(tempRoot)}/fi\\le.txt`)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("the symlink hop budget resolves a 40-link acyclic chain and stops at 41", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-hops-"))
    const target = path.join(tempRoot, "target")
    fs.mkdirSync(target)
    // chain\0 -> s1 -> ... -> s39 -> target is exactly 40 symlinks.
    let next = target
    for (let i = 39; i >= 1; i--) {
      const link = path.join(tempRoot, `s${i}`)
      fs.symlinkSync(next, link)
      next = link
    }
    const forty = path.join(tempRoot, "chain\\0")
    fs.symlinkSync(next, forty)
    // One more link on the same chain takes the walk past the 40-hop budget.
    const fortyOne = path.join(tempRoot, "chain\\1")
    fs.symlinkSync(forty, fortyOne)

    try {
      expect(comparablePath(forty)).toBe(comparablePath(target))
      expect(comparablePath(fortyOne)).toBe(fortyOne)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a trailing slash after a literal-backslash symlink keeps the target directory identity", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-slash-"))
    const inside = path.join(tempRoot, "inside")
    const outside = path.join(tempRoot, "outside")
    fs.mkdirSync(inside)
    fs.mkdirSync(outside)
    const link = path.join(inside, "link\\name")
    fs.symlinkSync(outside, link)

    try {
      expect(comparablePath(`${link}/`)).toBe(comparablePath(outside))
      expect(sameDirectory(`${link}/`, outside)).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("a POSIX symlink cycle falls back to the literal spelling instead of hanging", () => {
    if (process.platform === "win32") return

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-backslash-cycle-"))
    const a = path.join(tempRoot, "cycle\\a")
    const b = path.join(tempRoot, "cycle\\b")
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)

    try {
      expect(comparablePath(a)).toBe(a)
      expect(comparablePath(b)).toBe(b)
      expect(sameDirectory(a, a)).toBe(true)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
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
