export * as ConfigModel from "./model.js"

import { Schema, SchemaGetter } from "effect"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { optional } from "../schema.js"

const ProviderID = Provider.ID.check(Schema.isPattern(/^[^/#]+$/))
const ModelID = Model.ID.check(Schema.isPattern(/^[^#]+$/))
const VariantID = Model.VariantID.check(Schema.isPattern(/^[^#]+$/))

const Explicit = Schema.Struct({
  providerID: ProviderID,
  model: ModelID,
  variant: VariantID.pipe(optional),
})

const Short = Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+(?:#[^#]+)?$/))

export interface Selection extends Schema.Schema.Type<typeof Explicit> {}
export const Selection = Schema.Union([Short, Explicit])
  .pipe(
    Schema.decodeTo(Explicit, {
      decode: SchemaGetter.transform((input) => (typeof input === "string" ? parse(input) : input)),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
  .annotate({ identifier: "Config.ModelSelection" })

// A favorite names provider/model without a variant, so one entry covers every variant of the
// same model and toggling in the picker touches exactly that row.
export type Favorites = Schema.Schema.Type<typeof Favorites>
export const Favorites = Schema.Array(Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+$/))).annotate({
  identifier: "Config.ModelFavorites",
})

function parse(input: string): Selection {
  const ref = Model.Ref.parse(input)
  return {
    providerID: ref.providerID,
    model: ref.id,
    ...(ref.variant ? { variant: ref.variant } : {}),
  }
}
