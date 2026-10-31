/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { once } from "node:events"
import { Mode } from "@orchestra/schema/mode"
import { DialogJailbreak, jailbreakOptions } from "../src/component/dialog-jailbreak"
import { DialogMode, modeRows } from "../src/component/dialog-mode"
import { renderLocal, session } from "./fixture/local"

type Setup = Awaited<ReturnType<typeof renderLocal>>

// The dialog paints before its deferred filter focus is ready for typing.
async function focusFilter(setup: Setup) {
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable)
}

// The mode list is taller than the test terminal, so narrow it to the row under test.
async function filterTo(setup: Setup, query: string, ready: (frame: string) => boolean) {
  await focusFilter(setup)
  await setup.mockInput.typeText(query)
  return setup.waitForFrame(ready)
}

async function openPolicies(setup: Setup, sessionID?: string) {
  setup.dialog.replace(() => <DialogMode sessionID={sessionID} />)
  await setup.waitForFrame((frame) => frame.includes("Work mode") && frame.includes("Coding"))
  const filtered = await filterTo(setup, "Jailbreak", (frame) => frame.includes("Jailbreak") && !frame.includes("Coding"))
  // Exactly one row: were the policies listed here, every one of them would match the filter too.
  expect(filtered.split("\n").filter((line) => line.includes("Run the bundled jailbreak policy"))).toHaveLength(1)
  for (const name of ["Beam", "Muse-wonder", "Mistral-Large-4"]) expect(filtered).not.toContain(name)
  setup.mockInput.pressEnter()
  return setup.waitForFrame((frame) => frame.includes("Automatic (fits the model)"))
}

test("the picker collapses the 34 policies into one Jailbreak row and keeps read-only labels", () => {
  const rows = modeRows([...Mode.builtins, ...Mode.jailbreakModes()])

  expect(rows.filter((row) => row.title === "Jailbreak")).toHaveLength(1)
  // Every ordinary mode stays, in the schema's own order, and no policy is a row of its own.
  expect(rows.map((row) => row.value)).toEqual(Mode.builtins.map((mode) => String(mode.id)))
  expect(rows.some((row) => row.value.startsWith(Mode.jailbreakPrefix))).toBe(false)
  // A step allowance is an engineering detail of the mode, not something to choose between.
  expect(rows.filter((row) => /\d+ steps/.test(row.description))).toEqual([])
  expect(rows.some((row) => row.description.includes("read-only"))).toBe(true)

  const options = jailbreakOptions()
  expect(options).toHaveLength(1 + Mode.jailbreakModes().length)
  expect(options[0]?.title).toBe("Automatic (fits the model)")
  expect(options[0]?.value).toBe("jailbreak")
  expect(options.slice(1).map((option) => option.value)).toEqual(Mode.jailbreakModes().map((mode) => String(mode.id)))
})

test("the one Jailbreak row opens the policy list with Automatic first", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => <DialogMode />)

  const frame = await setup.waitForFrame((frame) => frame.includes("Work mode") && frame.includes("Coding"))
  // The policies are modes of their own, yet none of them is listed next to the work modes.
  for (const name of ["Beam", "Muse-wonder", "Mistral-Large-4"]) expect(frame).not.toContain(name)

  const nested = await openPolicies(setup)
  expect(nested).toContain("Jailbreak")
  expect(nested).toContain("Beam")
  // Replacing the picker keeps a single dialog open, so Escape can lead back instead of closing both.
  expect(setup.dialog.stack.length).toBe(1)

  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.mode.current()).toBe("jailbreak")
})

test("a policy row pins jailbreak:<id>, and Escape returns to the mode list", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => <DialogJailbreak />)
  await setup.waitForFrame((frame) => frame.includes("Automatic (fits the model)"))

  const policy = Mode.jailbreakModes().at(-1)!
  await filterTo(setup, policy.name, (frame) => frame.includes(policy.name))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.mode.current()).toBe(String(policy.id))

  // The collapsed row still opens the policies, and going back lands on the picker.
  await openPolicies(setup)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Work mode"))
  expect(setup.dialog.stack.length).toBe(1)
})

test("a session row stores the pinned policy through setFor", async () => {
  const calls: Array<{ metadata?: Record<string, unknown> }> = []
  await using setup = await renderLocal({
    sessions: [session("ses_1")],
    fetch: async (url, request) => {
      if (url.pathname !== "/api/session/ses_1" || request.method !== "PATCH") return
      calls.push(await request.json())
      return new Response(null, { status: 204 })
    },
  })
  await setup.data.session.sync("ses_1")
  expect(setup.local.mode.currentFor("ses_1")).toBe("auto")

  await openPolicies(setup, "ses_1")

  const policy = Mode.jailbreakModes()[0]!
  await filterTo(setup, policy.name, (frame) => frame.includes(policy.name))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => calls.length === 1)
  expect(calls[0]?.metadata).toEqual({ [Mode.MetadataKey]: String(policy.id) })
})
