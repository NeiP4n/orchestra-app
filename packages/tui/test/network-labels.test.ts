import { expect, test } from "bun:test"
import { claimNetworkLabel, networkNames, type LabelRect } from "../src/util/network-labels"
test("different Browser 4 chat IDs get stable disambiguated network labels without renaming data", () => {
  const items = [{ id: "a", title: "Browser 4" }, { id: "b", title: "Browser 4" }]
  const names = networkNames(items)
  expect(names.a).not.toBe(names.b)
  expect(networkNames([...items].reverse())).toEqual(names)
  expect(items[0]!.title).toBe("Browser 4")
})
test("a tool or hub label cannot overwrite another label's suffix", () => {
  const occupied: LabelRect[] = []
  expect(claimNetworkLabel(occupied, { x: 2, y: 3, width: 14 })).toBe(true)
  expect(claimNetworkLabel(occupied, { x: 12, y: 3, width: 10 })).toBe(false)
  expect(claimNetworkLabel(occupied, { x: 12, y: 4, width: 10 })).toBe(true)
})
