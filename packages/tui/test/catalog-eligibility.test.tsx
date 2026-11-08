import { expect, test } from "bun:test"
import { renderLocal } from "./fixture/local"
import { freeModel } from "./fixture/catalog"

for (const kind of ["free", "disabled", "paid-unconnected", "deprecated"] as const) {
  test(`catalog fixture default eligibility: ${kind}`, async () => {
    const model = freeModel("model", "demo", "Demo Model")
    if (kind === "disabled") model.enabled = false
    if (kind === "deprecated") model.status = "deprecated"
    if (kind === "paid-unconnected") model.cost = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }]
    await using setup = await renderLocal({
      models: [model],
      view: () => <text>Catalog eligibility probe mounted</text>,
    })
    const frame = await setup.waitForFrame(frame => frame.includes("Catalog eligibility probe mounted"))
    expect(frame.trim().length).toBeGreaterThan(0)
    console.log(JSON.stringify({ kind, selected: setup.local.model.current(), frame }))
    if (kind === "free") expect(setup.local.model.current()).toEqual({ providerID: "demo", modelID: "model" })
    else expect(setup.local.model.current()).toBeUndefined()
  })
}
