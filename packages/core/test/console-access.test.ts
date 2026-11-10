import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { ConsoleAccess as A } from "../src/console-access"
const scope = {
  sessionID: "ses_fixture",
  directory: "/tmp/project",
  projectID: "prj_fixture",
  kind: "plain" as const,
  ptyID: "pty_fixture",
}
function fixture(run: () => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-access-")),
    prior = process.env.ORCHESTRA_STATE_DIR
  process.env.ORCHESTRA_STATE_DIR = dir
  try {
    run()
  } finally {
    if (prior === undefined) delete process.env.ORCHESTRA_STATE_DIR
    else process.env.ORCHESTRA_STATE_DIR = prior
    rmSync(dir, { recursive: true, force: true })
  }
}
test("Console OFF default, exact chat/directory/terminal, read-only, revoke and corrupt fail closed", () =>
  fixture(() => {
    expect(() => A.requireRead(scope)).toThrow("OFF")
    expect(() => A.requireWrite(scope, "echo ok\n")).toThrow()
    A.select(scope)
    expect(A.selected(scope.sessionID)).toEqual(scope)
    expect(A.selected("other")).toBeUndefined()
    A.set(scope, "read")
    A.requireRead(scope)
    expect(() => A.requireWrite(scope, "echo ok\n")).toThrow()
    for (const changed of [
      { sessionID: "other" },
      { projectID: "prj_other" },
      { directory: "/tmp/other" },
      { ptyID: "pty_other" },
      { kind: "persistent" as const },
    ])
      expect(() => A.requireRead({ ...scope, ...changed })).toThrow("OFF")
    A.set(scope, "off")
    expect(() => A.requireRead(scope)).toThrow("OFF")
    A.set(scope, "full")
    A.requireWrite(scope, "\x03")
    A.set(scope, "off")
    expect(() => A.requireWrite(scope, "\x03")).toThrow()
  }))
test("exact command confirmation is single-use, revision-bound and does not authorize another command", () =>
  fixture(() => {
    A.set(scope, "confirm")
    expect(() => A.requireWrite(scope, "echo ok\n")).toThrow("awaiting")
    const request = A.current(scope)
    expect(request.pending).toBe("echo ok\n")
    expect(() => A.approve(scope, "echo different\n", request.revision)).toThrow()
    A.approve(scope, "echo ok\n", request.revision)
    expect(() => A.requireWrite(scope, "echo ok\n")).not.toThrow()
    expect(() => A.requireWrite(scope, "echo ok\n")).toThrow("awaiting")
    A.set(scope, "off")
    expect(() => A.approve(scope, "echo ok\n", request.revision)).toThrow()
    A.set(scope, "confirm")
    for (const text of ["echo a\necho b\n", "\x03", "echo ok\r\n"]) expect(() => A.requireWrite(scope, text)).toThrow()
  }))
test("expiry, corrupt grants and stale locks deny; journal never stores command or output", () =>
  fixture(() => {
    A.set(scope, "full")
    A.journal(scope, "write", "echo private-value\n")
    expect(A.recent(scope)).toHaveLength(1)
    const dir = path.join(process.env.ORCHESTRA_STATE_DIR!, "console-access"),
      grant = readdirSync(dir).find((name) => name.endsWith(".json"))!
    const file = path.join(dir, grant),
      value = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify({ ...value, expiresAt: 1 }))
    expect(() => A.requireRead(scope)).toThrow()
    A.set(scope, "full")
    writeFileSync(file + ".lock", "stale")
    expect(() => A.requireRead(scope)).toThrow()
    expect(() => A.requireWrite(scope, "echo ok\n")).toThrow()
    const journal = readdirSync(dir).find((name) => name.endsWith(".jsonl"))!
    expect(readFileSync(path.join(dir, journal), "utf8")).not.toContain("private-value")
  }))

test("in-flight adapter operation serializes revoke and new selection cannot inherit another project grant", () =>
  fixture(() => {
    A.select(scope)
    A.set(scope, "full")
    const release = A.acquire(scope, "write", "echo ok\n")
    expect(() => A.set(scope, "off")).toThrow()
    expect(() => A.acquire(scope, "read")).toThrow()
    release()
    A.set(scope, "off")
    expect(() => A.acquire(scope, "read")).toThrow()
  }))

test("closed or switched Console cannot reuse a still-live grant", () =>
  fixture(() => {
    A.select(scope)
    A.set(scope, "full")
    A.unselect(scope)
    expect(A.selected(scope.sessionID)).toBeUndefined()
    expect(() => A.acquire(scope, "read")).toThrow("selection")
    const next = { ...scope, ptyID: "pty_next" }
    A.select(next)
    A.unselect(scope)
    expect(A.selected(scope.sessionID)).toEqual(next)
    expect(() => A.acquire(scope, "write", "echo old\n")).toThrow("selection")
    expect(() => A.acquire(next, "read")).toThrow("OFF")
  }))
