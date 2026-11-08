import { expect, test } from "bun:test"
import path from "node:path"

// TEMP timing capture: import @playwright/test + the config in a fresh child
// process with an explicit per-child deadline, and record spawn elapsed, exit
// code, signal and stderr on failure. The per-test budgets below are capture
// headroom, not a global timeout change; tighten them to the measured cold
// startup once CI records real numbers (Windows cold imports were exceeding
// the default 5s and leaving exitCode null with no diagnostics).
const CHILD_DEADLINE_MS = 15_000
const TEST_BUDGET_MS = 20_000

type Probe = {
  exitCode: number | null
  signal: string | null
  elapsedMs: number
  stdout: string
  stderr: string
  timedOut: boolean
}

async function probeConfig(code: string, env: NodeJS.ProcessEnv, deadlineMs = CHILD_DEADLINE_MS): Promise<Probe> {
  const started = performance.now()
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let killer: ReturnType<typeof setTimeout> | undefined
  let escalator: ReturnType<typeof setTimeout> | undefined
  try {
    killer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      escalator = setTimeout(() => proc.kill("SIGKILL"), 1_000)
    }, deadlineMs)
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const elapsedMs = Math.round(performance.now() - started)
    const probe: Probe = { exitCode, signal: proc.signalCode, elapsedMs, stdout, stderr, timedOut }
    console.info(`[pw-config-probe] elapsed=${elapsedMs}ms exit=${exitCode} signal=${proc.signalCode ?? "none"} timedOut=${timedOut}`)
    return probe
  } finally {
    if (killer !== undefined) clearTimeout(killer)
    if (escalator !== undefined) clearTimeout(escalator)
  }
}

function expectCleanExit(probe: Probe) {
  if (probe.timedOut || probe.exitCode !== 0) {
    throw new Error(
      `config import child failed: exit=${probe.exitCode} signal=${probe.signal ?? "none"} ` +
        `elapsed=${probe.elapsedMs}ms timedOut=${probe.timedOut}\nstderr:\n${probe.stderr}`,
    )
  }
}

test.each([
  { name: "local development", ci: "", build: "", built: false },
  { name: "local production build", ci: "", build: "1", built: true },
  { name: "CI production build", ci: "true", build: "", built: true },
  { name: "CI cannot opt into development", ci: "true", build: "0", built: true },
])(
  "Playwright uses $name",
  async ({ ci, build, built }) => {
    const probe = await probeConfig('import config from "./playwright.config.ts"; console.log(JSON.stringify(config))', {
      ...process.env,
      CI: ci,
      PLAYWRIGHT_BUILD: build,
      PLAYWRIGHT_BASE_URL: undefined,
      PLAYWRIGHT_PORT: "4321",
      PLAYWRIGHT_SERVER_HOST: "127.0.0.2",
      PLAYWRIGHT_SERVER_PORT: "4322",
    })
    expectCleanExit(probe)

    const config = JSON.parse(probe.stdout)
    expect(config.use.baseURL).toBe("http://127.0.0.1:4321")
    expect(config.webServer.url).toBe(config.use.baseURL)
    expect(config.webServer.command).toBe(
      built
        ? "bun run build && bun run serve -- --host 127.0.0.1 --port 4321 --strictPort"
        : "bun run dev -- --host 127.0.0.1 --port 4321 --strictPort",
    )
    expect(config.webServer.reuseExistingServer).toBe(!built)
    expect(config.webServer.env).toEqual({
      VITE_ORCHESTRA_TEST_FIXTURES: "1",
      VITE_ORCHESTRA_SERVER_HOST: built ? "127.0.0.1" : "127.0.0.2",
      VITE_ORCHESTRA_SERVER_PORT: built ? "4321" : "4322",
    })
  },
  TEST_BUDGET_MS,
)

test.each([
  "./playwright.config.ts",
  "./e2e/performance/playwright.config.ts",
  "./e2e/performance/playwright.uncapped.config.ts",
  "./e2e/performance/timeline-stability/playwright.config.ts",
])(
  "%s leaves an explicit external app unmanaged",
  async (file) => {
    const probe = await probeConfig(
      `import config from ${JSON.stringify(file)}; console.log(JSON.stringify({ ...config, fixtureHost: process.env.PLAYWRIGHT_SERVER_HOST, fixturePort: process.env.PLAYWRIGHT_SERVER_PORT }))`,
      { ...process.env, CI: "true", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:4444" },
    )
    expectCleanExit(probe)

    const config = JSON.parse(probe.stdout)
    expect(config.webServer).toBeUndefined()
    expect(config.use.baseURL).toBe("http://127.0.0.1:4444")
    expect(config.fixtureHost).toBe("127.0.0.1")
    expect(config.fixturePort).toBe("4444")
  },
  TEST_BUDGET_MS,
)

test("probe terminates a slow child and reports the timeout cause", async () => {
  // Negative control: a child that never answers must be killed at the deadline,
  // not waited on, and the failure must carry the timeout cause.
  const probe = await probeConfig("setTimeout(() => {}, 60_000)", { ...process.env }, 500)
  expect(probe.timedOut).toBe(true)
  expect(probe.exitCode !== 0 || probe.signal !== null).toBe(true)
  expect(probe.elapsedMs).toBeLessThan(10_000)
  expect(() => expectCleanExit(probe)).toThrow(/timedOut=true/)
})

test(
  "Playwright rejects HTTPS targets unsupported by the API fixtures",
  async () => {
    const probe = await probeConfig('import "./playwright.config.ts"', {
      ...process.env,
      CI: "true",
      PLAYWRIGHT_BASE_URL: "https://e2e.example.com",
    })
    expect(probe.timedOut).toBe(false)
    expect(probe.exitCode).not.toBe(0)
    expect(probe.stderr).toContain("E2E fixtures require an http:// app URL")
  },
  TEST_BUDGET_MS,
)
