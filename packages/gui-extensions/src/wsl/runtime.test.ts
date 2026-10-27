import { expect, test } from "bun:test"
import { createWslRuntime, wslArgs } from "./runtime"
import { discoverScript, installScript } from "./remote-cli"

test("requires an explicit installer URL for WSL remote CLI installation", () => {
  const previous = process.env.ORCHESTRA_INSTALLER_URL
  delete process.env.ORCHESTRA_INSTALLER_URL
  delete process.env.ORCHESTRA_INSTALL_URL

  try {
    expect(() => installScript({ version: "2.0.0" })).toThrow("Remote CLI installer URL is not configured")

    const script = installScript({
      version: "2.0.0",
      url: "https://custom.test/install.sh",
    })

    expect(script).toContain("curl -fsSL 'https://custom.test/install.sh'")
    expect(script).not.toContain("anomalyco/opencode")

    process.env.ORCHESTRA_INSTALLER_URL = "https://env.test/install.sh"

    const envScript = installScript({ version: "2.0.0" })

    expect(envScript).toContain("curl -fsSL 'https://env.test/install.sh'")
    expect(envScript).not.toContain("anomalyco/opencode")
  } finally {
    delete process.env.ORCHESTRA_INSTALLER_URL
    delete process.env.ORCHESTRA_INSTALL_URL

    if (previous !== undefined) process.env.ORCHESTRA_INSTALLER_URL = previous
  }
})

test("WSL CLI discovery prefers Orchestra and falls back to the legacy OpenCode installation", () => {
  const script = discoverScript()
  expect(script.indexOf("$HOME/.orchestra/bin/orchestra")).toBeLessThan(
    script.indexOf("$HOME/.opencode/bin/opencode"),
  )
  expect(script).toContain('$HOME/.opencode/bin/opencode')
})

test("wslArgs bypasses the distro default shell", () => {
  expect(wslArgs(["sh", "-lc", 'printf "%s\\n" "$HOME"'], "Debian")).toEqual([
    "-d",
    "Debian",
    "--exec",
    "sh",
    "-lc",
    'printf "%s\\n" "$HOME"',
  ])
  expect(wslArgs(["bash", "-se"], "Debian", "root")).toEqual([
    "-d",
    "Debian",
    "--user",
    "root",
    "--exec",
    "bash",
    "-se",
  ])
})

// Exercise the real wsl.exe argv path: with `--`, WSL routes the command line through the distro's
// default shell, which expands `$cli` to "" before `sh` runs the script (#48640).
const runtime = createWslRuntime((key) => key)

const distro =
  process.platform === "win32" && (await runtime.probeRuntime()).available
    ? (await runtime.listInstalled().catch(() => [])).find((item) => item.isDefault)?.name
    : undefined

// A cold WSL VM takes several seconds to answer.
test.skipIf(!distro)(
  "inline scripts keep their own variable expansion inside WSL",
  async () => {
    const result = await runtime.runWslSh(['cli="from-script"', 'printf "%s\\n" "$cli"'].join("\n"), distro)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("from-script")
  },
  30_000,
)
