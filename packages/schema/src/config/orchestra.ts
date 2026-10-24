export * as ConfigOrchestra from "./orchestra.js"

import { Schema } from "effect"
import { optional } from "../schema.js"
import { ConfigModel } from "./model.js"

// A team worker runs its role's own model when the role sets one. These models answer for a
// role that sets none, so workers can stay off the Orchestrator's model and its limits.
// `model` is the model the worker starts on; `models` are the ones it may continue on when the
// provider refuses the current model outright instead of failing the task. An explicit model
// from the role or from a single task always wins.
export class Policy extends Schema.Class<Policy>("Config.Orchestra.Worker.Policy")({
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model a worker runs when its role sets none, as provider/model or provider/model#variant",
  }),
  models: Schema.Array(ConfigModel.Selection).pipe(optional).annotate({
    description: "Models a worker may continue on when the provider refuses its current model",
  }),
}) {}

export class Worker extends Schema.Class<Worker>("Config.Orchestra.Worker")({
  ...Policy.fields,
  categories: Schema.Record(Schema.String, Policy).pipe(optional).annotate({
    description: "Per role category overrides of model and models, matched ignoring case (Planning, Build, Quality, ...)",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Orchestra")({
  worker: Worker.pipe(optional),
}) {}
