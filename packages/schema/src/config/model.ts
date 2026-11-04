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

/**
 * A named, user-managed collection of models. Entries are "provider/model"
 * refs (the favorites format), so a collection may span providers and
 * custom endpoints. Collections live in the global config document and are
 * resolved against the live provider registry at read time: an entry whose
 * provider or model is currently unavailable simply does not resolve, and
 * deleting a provider never rewrites the collection.
 */
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
export const Collection = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-_]*$/)),
  name: Schema.String,
  enabled: Schema.Boolean,
  models: Favorites,
}).annotate({ identifier: "Config.ModelCollection" })

export type Collections = Schema.Schema.Type<typeof Collections>
export const Collections = Schema.Array(Collection).annotate({ identifier: "Config.ModelCollections" })

function parse(input: string): Selection {
  const ref = Model.Ref.parse(input)
  return {
    providerID: ref.providerID,
    model: ref.id,
    ...(ref.variant ? { variant: ref.variant } : {}),
  }
}
