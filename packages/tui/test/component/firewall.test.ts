import { expect, test } from "bun:test"
import { firewallAllows, firewallRules, parseFirewall } from "../../src/component/dialog-rooms"

test("each firewall purpose has its own rule, so Connect never drops the port Host allowed", () => {
  expect(firewallRules([])).toEqual(["orchestra rooms", "orchestra rooms discovery"])
  expect(firewallRules([49375])).toEqual(["orchestra rooms", "orchestra rooms discovery", "orchestra rooms tcp 49375"])
})

test("the rooms are allowed only with every rule present and no block rule for the program", () => {
  const all = "rule:orchestra rooms\r\nrule:orchestra rooms discovery\r\nrule:orchestra rooms tcp 49375\r\n"
  expect(firewallAllows(parseFirewall(all, [49375]))).toBe(true)
  // Connect needs no server port, so Host's extra rule does not matter to it
  expect(firewallAllows(parseFirewall(all, []))).toBe(true)
  expect(parseFirewall("rule:orchestra rooms\r\nrule:orchestra rooms discovery\r\n", [49375])).toEqual({
    missing: ["orchestra rooms tcp 49375"],
    blocked: false,
  })
  expect(firewallAllows(parseFirewall(`${all}block\r\n`, [49375]))).toBe(false)
  expect(firewallAllows(parseFirewall("", []))).toBe(false)
})
