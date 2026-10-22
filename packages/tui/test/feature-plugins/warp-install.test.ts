import { describe, expect, test } from "bun:test"
import {
  installerExitSucceeded,
  installerFailureDetail,
  warpWingetArgs,
} from "../../src/feature-plugins/system/warp-install"

describe("WARP installer arguments", () => {
  test("asks winget for the exact package, silently and machine-wide", () => {
    const args = warpWingetArgs()
    expect(args.slice(0, 4)).toEqual(["install", "--id", "Cloudflare.Warp", "-e"])
    expect(args[args.indexOf("--source") + 1]).toBe("winget")
    expect(args[args.indexOf("--scope") + 1]).toBe("machine")
    expect(args).toContain("--silent")
    expect(args).toContain("--accept-package-agreements")
    expect(args).toContain("--accept-source-agreements")
  })
})

describe("WARP installer exit codes", () => {
  test("a finished install and a pending reboot both count as finished", () => {
    expect(installerExitSucceeded("winget", 0)).toBe(true)
    expect(installerExitSucceeded("winget", 3010)).toBe(true)
    expect(installerExitSucceeded("brew", 0)).toBe(true)
  })

  test("winget's nothing-to-do answers are not failures", () => {
    expect(installerExitSucceeded("winget", 43)).toBe(true)
    expect(installerExitSucceeded("winget", 0x8a15002b)).toBe(true)
    expect(installerExitSucceeded("winget", 0x8a150061)).toBe(true)
  })

  test("the inner installer's exit code is a failure", () => {
    expect(installerExitSucceeded("winget", 255)).toBe(false)
    expect(installerExitSucceeded("winget", 1603)).toBe(false)
    expect(installerExitSucceeded("brew", 255)).toBe(false)
  })

  test("winget's nothing-to-do answers decide nothing for another package manager", () => {
    expect(installerExitSucceeded("brew", 43)).toBe(false)
    expect(installerExitSucceeded("sudo", 0x8a15002b)).toBe(false)
  })

  test("a process that never reported a code did not succeed", () => {
    expect(installerExitSucceeded("winget", null)).toBe(false)
    expect(installerExitSucceeded("brew", null)).toBe(false)
    expect(installerExitSucceeded("winget", undefined)).toBe(false)
    expect(installerExitSucceeded("brew", undefined)).toBe(false)
  })
})

describe("WARP installer failure detail", () => {
  test("flattens the package manager's own words", () => {
    expect(installerFailureDetail("Found Cloudflare.Warp\nInstaller failed with exit code: 255\n")).toBe(
      "Found Cloudflare.Warp Installer failed with exit code: 255",
    )
  })

  test("keeps the tail that names the failing step when the log is long", () => {
    const output = Array.from({ length: 400 }, (_, index) => `step ${index}`).join("\n")
    const detail = installerFailureDetail(output, 60)
    expect(detail.length).toBeLessThanOrEqual(61)
    expect(detail.endsWith("step 399")).toBe(true)
  })

  test("reports nothing when the installer printed nothing", () => {
    expect(installerFailureDetail("   \n\t")).toBe("")
  })
})
