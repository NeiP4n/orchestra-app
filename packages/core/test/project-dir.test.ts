import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ProjectDir } from "../src/project-dir"

describe("ProjectDir resolution", () => {
  const tmpDir = path.resolve(import.meta.dir, "../../..", "node_modules/.tmp/project-dir-test")

  test("resolveRead prioritizes .orchestra when both exist", () => {
    const root = path.join(tmpDir, "read-both")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".orchestra"), { recursive: true })
    mkdirSync(path.join(root, ".opencode"), { recursive: true })
    writeFileSync(path.join(root, ".orchestra", "dod.yaml"), "orchestra-dod")
    writeFileSync(path.join(root, ".opencode", "dod.yaml"), "opencode-dod")

    expect(ProjectDir.resolveRead(root, "dod.yaml")).toBe(path.join(root, ".orchestra", "dod.yaml"))
  })

  test("resolveRead falls back to .opencode when only legacy exists", () => {
    const root = path.join(tmpDir, "read-legacy")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".opencode"), { recursive: true })
    writeFileSync(path.join(root, ".opencode", "dod.yaml"), "opencode-dod")

    expect(ProjectDir.resolveRead(root, "dod.yaml")).toBe(path.join(root, ".opencode", "dod.yaml"))
  })

  test("resolveRead uses .orchestra when only new exists", () => {
    const root = path.join(tmpDir, "read-new")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".orchestra"), { recursive: true })
    writeFileSync(path.join(root, ".orchestra", "dod.yaml"), "orchestra-dod")

    expect(ProjectDir.resolveRead(root, "dod.yaml")).toBe(path.join(root, ".orchestra", "dod.yaml"))
  })

  test("resolveRead defaults to .orchestra when neither exists", () => {
    const root = path.join(tmpDir, "read-none")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })

    expect(ProjectDir.resolveRead(root, "dod.yaml")).toBe(path.join(root, ".orchestra", "dod.yaml"))
  })

  test("resolveWrite keeps writing to .opencode when file only exists in legacy", () => {
    const root = path.join(tmpDir, "write-legacy-file")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".opencode"), { recursive: true })
    writeFileSync(path.join(root, ".opencode", "dod.yaml"), "opencode-dod")

    expect(ProjectDir.resolveWrite(root, "dod.yaml")).toBe(path.join(root, ".opencode", "dod.yaml"))
  })

  test("resolveWrite writes to .orchestra when file exists in both", () => {
    const root = path.join(tmpDir, "write-both-files")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".orchestra"), { recursive: true })
    mkdirSync(path.join(root, ".opencode"), { recursive: true })
    writeFileSync(path.join(root, ".orchestra", "dod.yaml"), "orchestra-dod")
    writeFileSync(path.join(root, ".opencode", "dod.yaml"), "opencode-dod")

    expect(ProjectDir.resolveWrite(root, "dod.yaml")).toBe(path.join(root, ".orchestra", "dod.yaml"))
  })

  test("resolveWrite writes to .opencode when only .opencode directory exists in project", () => {
    const root = path.join(tmpDir, "write-legacy-dir")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".opencode"), { recursive: true })

    expect(ProjectDir.resolveWrite(root, "new-file.md")).toBe(path.join(root, ".opencode", "new-file.md"))
  })

  test("resolveWrite writes to .orchestra when fresh project", () => {
    const root = path.join(tmpDir, "write-fresh")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })

    expect(ProjectDir.resolveWrite(root, "dod.yaml")).toBe(path.join(root, ".orchestra", "dod.yaml"))
  })

  test("resolveDirRead and resolveDirWrite follow directory fallback rules", () => {
    const root = path.join(tmpDir, "dir-test")
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, ".opencode", "notes"), { recursive: true })

    expect(ProjectDir.resolveDirRead(root, "notes")).toBe(path.join(root, ".opencode", "notes"))
    expect(ProjectDir.resolveDirWrite(root, "notes")).toBe(path.join(root, ".opencode", "notes"))

    mkdirSync(path.join(root, ".orchestra", "notes"), { recursive: true })
    expect(ProjectDir.resolveDirRead(root, "notes")).toBe(path.join(root, ".orchestra", "notes"))
    expect(ProjectDir.resolveDirWrite(root, "notes")).toBe(path.join(root, ".orchestra", "notes"))
  })
})
