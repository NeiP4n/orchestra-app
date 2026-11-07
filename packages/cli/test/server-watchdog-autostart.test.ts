import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const WATCHDOG = path.resolve(import.meta.dir, "../../../scripts/server-watchdog.sh")
const INSTALLER = path.resolve(import.meta.dir, "../../../scripts/install-watchdog-autostart.sh")
const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

// Lifetime of the fake "live server" (a sleep process whose pid the lock
// names). Long on purpose: under parallel load a watchdog spawn takes
// tens of seconds, and a sleeper that dies mid-test would make a live
// lock look stale. Killed in each test's finally.
const SLEEPER_SECONDS = "600"

async function dataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "orchestra-watchdog-autostart-"))
}

/** A pid that is guaranteed dead: a child that already exited. */
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

/** Start time of a pid as an ISO string, from /proc (same source the watchdog reads). */
async function procStartISO(pid: number): Promise<string> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const starttime = Number(fields[19])
  const btimeLine = (await fs.readFile("/proc/stat", "utf8")).split("\n").find((line) => line.startsWith("btime "))
  const btime = Number(btimeLine?.split(/\s+/)[1])
  // CLK_TCK is 100 on Linux x86_64 (the watchdog itself falls back to 100);
  // the watchdog tolerates a 2s skew, so fixture precision is not critical.
  return new Date((btime + Math.floor(starttime / 100)) * 1000).toISOString()
}

async function writeLock(directory: string, pid: number, startedAt: string, port = 17890) {
  await fs.writeFile(
    path.join(directory, `server-${port}.lock`),
    JSON.stringify({ pid, hostname: "127.0.0.1", port, mode: "default", startedAt }),
  )
}

async function run(command: string[], args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code: await child.exited, stdout, stderr }
}

interface StubBun {
  directory: string
  log: string
  env: Record<string, string>
}

/**
 * A fake `bun` for the watchdog to call: `-e` field reads run on the real
 * bun, while a `serve` start only records the invocation and exits (the
 * real server is the thing under test's dependency, not the thing under
 * test). STUB_SERVE_DELAY / STUB_SERVE_EXIT tune the fake server.
 */
async function stubBun(directory: string): Promise<StubBun> {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-watchdog-stub-"))
  const log = path.join(directory, "serve-invocations.log")
  await fs.writeFile(
    path.join(stubDir, "bun"),
    `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then exec "${process.execPath}" "$@"; fi
echo "serve-invoked: $*" >> "${log}"
sleep "\${STUB_SERVE_DELAY:-0}"
exit "\${STUB_SERVE_EXIT:-0}"
`,
    { mode: 0o755 },
  )
  return {
    directory: stubDir,
    log,
    env: { PATH: `${stubDir}:${process.env.PATH ?? ""}` },
  }
}

async function invocationCount(log: string) {
  return fs
    .readFile(log, "utf8")
    .then((text) => text.split("\n").filter(Boolean).length)
    .catch(() => 0)
}

/** Poll until `check` is true or the deadline passes (the VM is heavily loaded by parallel runs; fixed sleeps are flaky here). */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

test("probe reports a live server and names its pid", async () => {
  const directory = await dataDir()
  const sleeper = Bun.spawn(["sleep", SLEEPER_SECONDS], { stdout: "ignore", stderr: "ignore" })
  try {
    await writeLock(directory, sleeper.pid, await procStartISO(sleeper.pid))
    const result = await run(WATCHDOG, ["--data-dir", directory, "--probe"], {})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`${sleeper.pid} (`)
    expect(result.stdout).toContain("server-17890.lock")
  } finally {
    sleeper.kill()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 180000)

test("probe says no server for a stale lock from a dead pid", async () => {
  const directory = await dataDir()
  try {
    await writeLock(directory, await deadPid(), "2026-11-06T00:00:00.000Z")
    const result = await run(WATCHDOG, ["--data-dir", directory, "--probe"], {})
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 180000)

test("probe rejects a recycled pid: live pid, wrong startedAt", async () => {
  const directory = await dataDir()
  const sleeper = Bun.spawn(["sleep", SLEEPER_SECONDS], { stdout: "ignore", stderr: "ignore" })
  try {
    await writeLock(directory, sleeper.pid, "2026-11-06T00:00:00.000Z")
    const result = await run(WATCHDOG, ["--data-dir", directory, "--probe"], {})
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("PID reuse")
  } finally {
    sleeper.kill()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 180000)

test("probe says no server when there is no lock", async () => {
  const directory = await dataDir()
  try {
    const result = await run(WATCHDOG, ["--data-dir", directory, "--probe"], {})
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 180000)

test("watchdog exits at once when a server is already running, without starting serve", async () => {
  const directory = await dataDir()
  const sleeper = Bun.spawn(["sleep", SLEEPER_SECONDS], { stdout: "ignore", stderr: "ignore" })
  const stub = await stubBun(directory)
  try {
    await writeLock(directory, sleeper.pid, await procStartISO(sleeper.pid))
    const result = await run(
      WATCHDOG,
      ["--data-dir", directory, "--max-restarts", "1", "--window-seconds", "60", "--backoff-base", "0", "--", "--port", "17890"],
      stub.env,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("server already running")
    expect(await invocationCount(stub.log)).toBe(0)
  } finally {
    sleeper.kill()
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(stub.directory, { recursive: true, force: true })
  }
}, 180000)

test("a second watchdog exits at once while the first holds the flock", async () => {
  const directory = await dataDir()
  const stub = await stubBun(directory)
  // max-restarts 0: the first watchdog exits after its single serve attempt,
  // so no second attempt can start while the second watchdog runs (under
  // load the second run takes seconds, and a second attempt would otherwise
  // start mid-check and break the count assertion).
  const args = ["--data-dir", directory, "--max-restarts", "0", "--window-seconds", "60", "--backoff-base", "0", "--", "--port", "17890"]
  const env = { ...process.env, ...stub.env, STUB_SERVE_DELAY: "20", STUB_SERVE_EXIT: "0" }
  const first = Bun.spawn([WATCHDOG, ...args], { stdout: "pipe", stderr: "pipe", env })
  try {
    await waitFor(async () => (await invocationCount(stub.log)) >= 1, 30000, "first watchdog to start serve")
    const before = await invocationCount(stub.log)
    const second = await run(WATCHDOG, args, env)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain("another watchdog already holds")
    expect(await invocationCount(stub.log)).toBe(before)
    expect(await first.exited).toBe(1)
  } finally {
    first.kill()
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(stub.directory, { recursive: true, force: true })
  }
}, 120000)

test("installer dry-run renders a unit with no placeholders, and --check passes it", async () => {
  const directory = await dataDir()
  try {
    const dry = await run(
      INSTALLER,
      ["--dry-run", "--data-dir", directory, "--worktree", REPO_ROOT],
      {},
    )
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain("ExecStart=")
    expect(dry.stdout).toContain("server-watchdog.sh")
    expect(dry.stdout).toContain("Restart=no")
    expect(dry.stdout).not.toContain("@WORKTREE@")
    expect(dry.stdout).not.toContain("@DATA_DIR@")
    expect(dry.stdout).not.toContain("@SERVICE_USER@")
    const check = await run(
      INSTALLER,
      ["--check", "--data-dir", directory, "--worktree", REPO_ROOT],
      {},
    )
    expect(check.code).toBe(0)
    expect(check.stdout).toContain("check: OK")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 180000)
