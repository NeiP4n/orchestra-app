export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  portable_shell_scanner: Schema.Boolean.pipe(optional).annotate({
    description: "Enable the experimental portable shell permission scanner. Defaults to false.",
  }),
  context_governor: Schema.Boolean.pipe(optional).annotate({
    description:
      "Leave old, bulky tool output out of model requests once they grow large, keeping the full history. Defaults to true; set it to false to send the whole history.",
  }),
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1.",
  }),
  neural_functional_effects: Schema.Boolean.pipe(optional).annotate({
    description:
      "Show functional effects in the neuron network, starting with the approval wait: a flipping half-circle beside a session whose question or permission is still open. Defaults to false.",
  }),
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Ordered policies controlling access to configured resources",
  }),
}) {}
