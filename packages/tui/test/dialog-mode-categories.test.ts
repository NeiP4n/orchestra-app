import { expect, test } from "bun:test"
import { Mode } from "@orchestra/schema/mode"
import { modeOptions } from "../src/component/dialog-mode"

test("the work mode picker lists every bundled policy under Jailbreak", () => {
  const options = modeOptions([...Mode.builtins, ...Mode.jailbreakModes()])

  expect(options.find((option) => option.value === "coding")?.category).toBe("Work modes")
  expect(options.filter((option) => option.category === "Jailbreak").map((option) => option.value)).toEqual([
    "jailbreak",
    ...Mode.jailbreakModes().map((mode) => String(mode.id)),
  ])
  // One section header per group: the ordinary modes first, the policies after them.
  expect(options.at(-1)).toMatchObject({ category: "Jailbreak" })
  expect(options.find((option) => option.value === "jailbreak:opus-v2")?.title).toBe("opus v2")
})
