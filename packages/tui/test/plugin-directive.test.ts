import { expect, test } from "bun:test"
import { pluginDirective } from "../src/plugin/directive"

test("plugin directives replace previous exact enablement without duplicating entries", () => {
  expect(
    pluginDirective(["opencode.home.footer", "-opencode.home.footer", "opencode.*"], "opencode.home.footer", false),
  ).toEqual(["opencode.home.footer", "opencode.*", "-opencode.home.footer"])
  expect(pluginDirective(["-opencode.home.footer"], "opencode.home.footer", true)).toEqual(["opencode.home.footer"])
})

test("plugin directives preserve package options when toggling an external plugin", () => {
  const packagePlugin = { package: "example-plugin", options: { enabled: true } }
  expect(pluginDirective([packagePlugin, "-other.plugin"], "example-plugin", false)).toEqual([
    packagePlugin,
    "-other.plugin",
    "-example-plugin",
  ])
  expect(pluginDirective([packagePlugin, "-example-plugin"], "example-plugin", true)).toEqual([packagePlugin])
})

test("an explicit enable overrides a wildcard exclusion that appears later", () => {
  expect(pluginDirective(["example.plugin", "-example.*"], "example.plugin", true)).toEqual([
    "-example.*",
    "example.plugin",
  ])
})

test("enabling a package after a wildcard exclusion retains its options and moves it last", () => {
  const packagePlugin = { package: "example-plugin", options: { enabled: true } }
  expect(pluginDirective([packagePlugin, "-example.*"], "example-plugin", true)).toEqual(["-example.*", packagePlugin])
})

test("plugin directives preserve unrelated declarations", () => {
  const packagePlugin = { package: "other-plugin", options: { enabled: true } }
  expect(pluginDirective([packagePlugin, "-other.plugin"], "example.plugin", false)).toEqual([
    packagePlugin,
    "-other.plugin",
    "-example.plugin",
  ])
})

test("disabling a local package preserves its source for the inactive row and restart", () => {
  const source = "/tmp/project/my-plugin"
  const disabled = pluginDirective([source], source, false)
  expect(disabled).toEqual([source, `-${source}`])
  expect(pluginDirective(disabled, source, false)).toEqual(disabled)
  expect(pluginDirective(disabled, source, true)).toEqual([source])
})
