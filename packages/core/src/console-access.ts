export * as ConsoleAccess from "./console-access.js"

import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Path } from "@orchestra/util/global"

export type Mode = "off" | "read" | "confirm" | "full"
export interface Scope {
  sessionID: string
  directory: string
  projectID?: string
  kind: "persistent" | "plain"
  ptyID: string
}
export interface Grant extends Scope {
  mode: Mode
  expiresAt: number
  pending?: string
  approved?: string
  revision: string
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const key = (scope: Scope) =>
  hash(JSON.stringify([scope.sessionID, scope.projectID ?? "", path.resolve(scope.directory), scope.kind, scope.ptyID]))
const root = () => path.join(Path.state, "console-access")
const file = (scope: Scope) => path.join(root(), key(scope) + ".json")
function readGrant(scope: Scope): Grant {
  const off: Grant = { ...scope, mode: "off", expiresAt: 0, revision: "" }
  try {
    const value = JSON.parse(fs.readFileSync(file(scope), "utf8")) as Grant
    if (
      key(value) !== key(scope) ||
      !["off", "read", "confirm", "full"].includes(value.mode) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      typeof value.revision !== "string" ||
      !value.revision ||
      (value.pending !== undefined && (typeof value.pending !== "string" || value.pending.length > 4096)) ||
      (value.approved !== undefined && (typeof value.approved !== "string" || !/^[a-f0-9]{64}$/.test(value.approved)))
    )
      return off
    return value
  } catch {
    return off
  }
}
export function current(scope: Scope): Grant {
  if (fs.existsSync(file(scope) + ".lock")) return { ...scope, mode: "off", expiresAt: 0, revision: "" }
  return readGrant(scope)
}
function locked<T>(scope: Scope, run: () => T): T {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 })
  const lock = file(scope) + ".lock"
  // Never break a stale lock by guessing. A crash blocks changes rather than granting access.
  const fd = fs.openSync(lock, "wx", 0o600)
  try {
    return run()
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}
function save(scope: Scope, value: Grant) {
  const temp = file(scope) + "." + randomUUID() + ".tmp"
  const fd = fs.openSync(temp, "wx", 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file(scope))
}
/** Operator UI only. No model tool exposes grant mutation or approval. Grants expire after one hour. */
export function set(scope: Scope, mode: Mode): void {
  if (!["off", "read", "confirm", "full"].includes(mode)) throw Error("Invalid console mode")
  locked(scope, () =>
    save(scope, { ...scope, mode, expiresAt: mode === "off" ? 0 : Date.now() + 3_600_000, revision: randomUUID() }),
  )
}
export function approve(scope: Scope, expected: string, revision: string): void {
  locked(scope, () => {
    const grant = readGrant(scope)
    if (grant.mode !== "confirm" || grant.pending !== expected || grant.revision !== revision)
      throw Error("Console request changed or expired")
    save(scope, { ...grant, pending: undefined, approved: hash(expected) })
  })
}
export function requireRead(scope: Scope): void {
  if (current(scope).mode === "off")
    throw Error("Console access is OFF. Only the operator can grant access for this exact chat and terminal.")
}
/** Checked at execution, not when the tool list is rendered. Confirmation is single-use. */
export function requireWrite(scope: Scope, text: string): void {
  if (!text || text.length > 4096) throw Error("Console input must contain 1-4096 characters")
  if (/sk-[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:password|api[_-]?key|token)\s*[=:]\s*\S{5,}/i.test(text))
    throw Error("Obvious secret-like input refused; use operator terminal directly. Vault injection is not connected.")
  locked(scope, () => {
    const grant = readGrant(scope)
    if (grant.mode === "full") return
    if (grant.mode !== "confirm") throw Error("Console writes are disabled")
    // Confirm mode is command-oriented; raw control keys require the explicit full mode.
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text) || !text.endsWith("\n") || text.slice(0, -1).includes("\n"))
      throw Error("Confirm mode accepts one complete command line only")
    if (grant.approved === hash(text)) {
      save(scope, { ...grant, approved: undefined })
      return
    }
    if (grant.pending && grant.pending !== text) throw Error("Another console command is awaiting the operator")
    save(scope, { ...grant, pending: text, approved: undefined })
    throw Error(
      "Exact command is awaiting operator review in Console access. Do not claim execution; retry only after approval.",
    )
  })
}
/** Serialize an admitted adapter operation against operator grant changes. */
export function acquire(scope: Scope, action: "read" | "write", text = ""): () => void {
  const target = selected(scope.sessionID)
  if (!target || key(target) !== key(scope)) throw Error("Console selection changed or closed")
  const revision = current(scope).revision
  if (action === "write") requireWrite(scope, text)
  else requireRead(scope)
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 })
  const lock = file(scope) + ".lock",
    fd = fs.openSync(lock, "wx", 0o600)
  try {
    const grant = readGrant(scope)
    const target = selected(scope.sessionID)
    if (!target || key(target) !== key(scope)) throw Error("Console selection changed before execution")
    if (
      grant.revision !== revision ||
      grant.mode === "off" ||
      (action === "write" && !["confirm", "full"].includes(grant.mode))
    )
      throw Error("Console grant changed before execution")
    journal(scope, action, text)
  } catch (error) {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
    throw error
  }
  return () => {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}

/** Journal records action/length/digest, never command or terminal output. Failure blocks execution. */
export function journal(scope: Scope, action: "read" | "write", text = ""): void {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 })
  fs.appendFileSync(
    path.join(root(), key(scope) + ".jsonl"),
    JSON.stringify({
      at: Date.now(),
      sessionID: scope.sessionID,
      ptyID: scope.ptyID,
      phase: "attempt",
      action,
      bytes: Buffer.byteLength(text),
      digest: text ? hash(text) : undefined,
    }) + "\n",
    { mode: 0o600 },
  )
}

export function recent(scope: Scope): Array<{ at: number; action: string; bytes: number }> {
  try {
    return fs
      .readFileSync(path.join(root(), key(scope) + ".jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(-8)
      .flatMap((line) => {
        const value = JSON.parse(line)
        return Number.isFinite(value.at) && ["read", "write"].includes(value.action) && Number.isFinite(value.bytes)
          ? [{ at: value.at, action: value.action, bytes: value.bytes }]
          : []
      })
  } catch {
    return []
  }
}

const selectedFile = (sessionID: string) => path.join(root(), "selected-" + hash(sessionID) + ".json")
function lockedSelection<T>(sessionID: string, run: () => T): T {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 })
  const lock = selectedFile(sessionID) + ".lock",
    fd = fs.openSync(lock, "wx", 0o600)
  try {
    return run()
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}
function readSelection(sessionID: string): Scope | undefined {
  try {
    const scope = JSON.parse(fs.readFileSync(selectedFile(sessionID), "utf8")) as Scope
    return scope.sessionID === sessionID &&
      typeof scope.projectID === "string" &&
      scope.projectID.length > 0 &&
      typeof scope.directory === "string" &&
      ["plain", "persistent"].includes(scope.kind) &&
      typeof scope.ptyID === "string" &&
      scope.ptyID.startsWith("pty")
      ? scope
      : undefined
  } catch {
    return undefined
  }
}
/** Exact visible Console target, written only by operator UI. Not a grant. */
export function select(scope: Scope): void {
  if (
    !scope.sessionID ||
    !scope.projectID ||
    !scope.directory ||
    !["plain", "persistent"].includes(scope.kind) ||
    !scope.ptyID.startsWith("pty")
  )
    throw Error("Invalid Console target")
  lockedSelection(scope.sessionID, () => {
    const temp = selectedFile(scope.sessionID) + "." + randomUUID() + ".tmp"
    fs.writeFileSync(temp, JSON.stringify(scope), { mode: 0o600 })
    fs.renameSync(temp, selectedFile(scope.sessionID))
  })
}
export function selected(sessionID: string): Scope | undefined {
  return fs.existsSync(selectedFile(sessionID) + ".lock") ? undefined : readSelection(sessionID)
}
/** Closing or switching withdraws its target, never a later selection. Compare and delete share a lock with select. */
export function unselect(scope: Scope): void {
  lockedSelection(scope.sessionID, () => {
    const current = readSelection(scope.sessionID)
    if (current && key(current) === key(scope))
      try {
        fs.unlinkSync(selectedFile(scope.sessionID))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
  })
}
