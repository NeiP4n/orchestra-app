import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { freeModel, provider } from "./fixture/catalog"

const staleModel = { id: "model", providerID: "demo", name: "Demo Model", variants: [] }
test("new-session catalog fixture matches current Model.Info wire schema", () => {
  expect(Schema.decodeUnknownSync(Model.Info)(freeModel("model", "demo", "Demo Model")).enabled).toBe(true)
})
test("provider fixture matches current Provider.Info wire schema", () => {
  expect(Schema.decodeUnknownSync(Provider.Info)(provider("demo", "Demo")).id).toBe("demo")
})

test("stale new-session model is rejected rather than silently normalized", () => {
  expect(() => Schema.decodeUnknownSync(Model.Info)(staleModel)).toThrow("modelID")
})
