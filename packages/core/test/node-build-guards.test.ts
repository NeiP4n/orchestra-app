import { describe, expect, test } from "bun:test"
import path from "node:path"

// Direct refusal tests for the node-build capability guards (Node follow-ups
// 2-4 plus the session-engine acquisition classification). Every case runs
// in a short-lived child process (fixture/node-build-guards-cases.ts): the
// module mocks of the runtime predicate and the PowerShell host, the win32
// platform override and the desktop env flags all die with the child, so
// this file leaves the shared test process untouched — later suites in the
// same process always see the real modules, platform and environment. No
// real desktop key or shell action ever runs in the child either.

// Plain name on purpose: *.test.ts files under the package are discovered
// into the shared full-suite process, where this runner's module mocks would
// leak. A non-matching name is run only through the explicit ./ path below.
const CHILD = "./test/fixture/node-build-guards-cases.ts"

const DESKTOP_ENV = [
  "ORCHESTRA_DESKTOP_CAPTURE",
  "ORCHESTRA_DESKTOP_REAL_SCREEN",
  "ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST",
  "ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL",
] as const

const realScreenGrant = {
  ORCHESTRA_DESKTOP_CAPTURE: "on",
  ORCHESTRA_DESKTOP_REAL_SCREEN: "on",
  ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST: "calculator",
  ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL: "2999-01-01T00:00:00.000Z",
} as const

/** Runs one guard case in a child process and fails with the child's output. */
const runCase = (name: string, desktopEnv: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
  // The child's desktop flags come only from this call, never from a leak.
  for (const key of DESKTOP_ENV) delete env[key]
  Object.assign(env, desktopEnv)

  // mock.module only intercepts inside the test runner, so the child is
  // itself a bun-test file and the case is selected by exact name.
  const child = Bun.spawnSync([process.execPath, "test", CHILD, "-t", `^${name}$`], {
    cwd: path.join(import.meta.dirname, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = child.stdout.toString().trim()
  const err = child.stderr.toString().trim()
  expect(
    child.exitCode,
    `guard case ${name} exited ${child.exitCode}\nstdout: ${out}\nstderr: ${err}`,
  ).toBe(0)
  // bun test exits 0 even when the name filter matches nothing, so the
  // child's own summary is asserted too: exactly the one case ran and passed.
  // bun test writes the run summary to stderr, so both streams are checked.
  const combined = `${out}\n${err}`
  expect(combined, `guard case ${name} output:\n${combined}`).toMatch(/(^|\s)1 pass\b/)
  expect(combined, `guard case ${name} output:\n${combined}`).toMatch(/(^|\s)0 fail\b/)
}

describe("node-build capability guards", () => {
  test("session engine acquisition without the Bun runtime caches the capability with one warning and the journal keeps the record", () => {
    runCase("session-capability-warning")
  }, 30000)

  test("memory tool refuses before any mkdir or write without the Bun runtime, naming the Bun build", () => {
    runCase("memory-capability-refusal")
  }, 30000)

  test("memory tool reports the real cause for an operational database failure under Bun", () => {
    runCase("memory-operational-cause")
  }, 30000)

  test("codegraph refuses every action before any fs side effect without the Bun runtime", () => {
    runCase("codegraph-capability-refusal")
  }, 30000)

  test("win32 media keys refuse before the FFI call, naming Bun FFI", () => {
    runCase("desktop-media-ffi-refusal", realScreenGrant)
  }, 30000)

  test("the real-screen permission denial stays first, ahead of the media guard", () => {
    runCase("desktop-real-screen-first", { ORCHESTRA_DESKTOP_CAPTURE: "on" })
  }, 30000)

  test("non-media actions keep their PowerShell dispatch", () => {
    runCase("desktop-nonmedia-dispatch", realScreenGrant)
  }, 30000)
})
