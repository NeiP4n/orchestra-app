import { expect, test } from "bun:test"
import { binaryPath, discoverScript, parseRegistration, startScript } from "./bootstrap"
import { RemoteCli } from "./remote-cli"

test("ignores stopped services and registrations that do not match the healthy endpoint", () => {
  const registration = { url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }
  const frame = `ORCHESTRA_SSH_REGISTRATION_BEGIN\n${JSON.stringify(registration)}\nORCHESTRA_SSH_REGISTRATION_END\n`
  expect(parseRegistration(`ORCHESTRA_SSH_STATUS=stopped\n${frame}`)).toBeUndefined()
  expect(parseRegistration(`ORCHESTRA_SSH_STATUS=http://127.0.0.1:9999\n${frame}`)).toBeUndefined()
  expect(
    parseRegistration(
      `ORCHESTRA_SSH_STATUS=${registration.url}\nORCHESTRA_SSH_REGISTRATION_BEGIN\ninvalid\nORCHESTRA_SSH_REGISTRATION_END\n`,
    ),
  ).toBeUndefined()
})

test("rejects unsafe versions and platforms in remote installation paths", () => {
  expect(() => binaryPath('2.0.0"; whoami')).toThrow()
  expect(binaryPath("2.0.0")).toBe('$HOME/.orchestra/desktop-ssh/2.0.0/orchestra')
  expect(discoverScript).toContain('"$HOME"/.opencode/desktop-ssh/')
  expect(discoverScript).toContain(".orchestra/desktop-ssh")
  expect(startScript("2.0.0")).toContain('$HOME/.orchestra/desktop-ssh/2.0.0/orchestra')
  expect(RemoteCli.archiveUrl("linux-x64-baseline-musl", "2.0.0-beta.1")).toBe(
    "https://registry.npmjs.org/@orchestra/cli-linux-x64-baseline-musl/-/cli-linux-x64-baseline-musl-2.0.0-beta.1.tgz",
  )
  expect(() => RemoteCli.installScript({ version: '2.0.0"; whoami', source: { type: "installer" } })).toThrow()
  expect(() => RemoteCli.archiveUrl("linux-x64;whoami", "2.0.0")).toThrow()
})

test("remote CLI discovery and installation prefer Orchestra and retain the OpenCode fallback", () => {
  const discovery = RemoteCli.discoverScript({ fromPath: true })
  expect(discovery).toContain("command -v orchestra || command -v opencode")
  expect(discovery).toContain('$HOME/.orchestra/bin/orchestra')
  expect(discovery).toContain('$HOME/.opencode/bin/opencode')

  const install = RemoteCli.installScript({ version: "2.0.0", directory: ".orchestra/desktop-ssh/2.0.0", source: { type: "archive" } })
  expect(install).toContain('"$stage/package/bin/orchestra"')
  expect(install).toContain(".orchestra/desktop-ssh/2.0.0/orchestra")
})

test("requires an explicit installer URL for remote CLI installation", () => {
  const previous = process.env.ORCHESTRA_INSTALLER_URL
  delete process.env.ORCHESTRA_INSTALLER_URL
  delete process.env.ORCHESTRA_INSTALL_URL

  try {
    expect(() => RemoteCli.installScript({ version: "2.0.0", source: { type: "installer" } })).toThrow(
      RemoteCli.Failure,
    )

    const script = RemoteCli.installScript({
      version: "2.0.0",
      source: { type: "installer", url: "https://custom.test/install.sh" },
    })

    expect(script).toContain("curl -fsSL 'https://custom.test/install.sh'")
    expect(script).not.toContain("anomalyco/opencode")

    process.env.ORCHESTRA_INSTALLER_URL = "https://env.test/install.sh"

    const envScript = RemoteCli.installScript({
      version: "2.0.0",
      source: { type: "installer" },
    })

    expect(envScript).toContain("curl -fsSL 'https://env.test/install.sh'")
    expect(envScript).not.toContain("anomalyco/opencode")
  } finally {
    delete process.env.ORCHESTRA_INSTALLER_URL
    delete process.env.ORCHESTRA_INSTALL_URL

    if (previous !== undefined) process.env.ORCHESTRA_INSTALLER_URL = previous
  }
})
