export * as ConfigJailbreak from "./jailbreak.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Jailbreak.Info")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description: "Offer the Jailbreak work mode, which runs a bundled jailbreak prompt beside the base prompt. Defaults to true; set it to false to hide the mode.",
  }),
  prompt: Schema.String.pipe(optional).annotate({
    description:
      "Bundled jailbreak policy the bare `jailbreak` mode runs, by id. Defaults to the policy that fits the model; a session that pins `jailbreak:<id>` ignores it. Ids are listed in packages/schema/src/jailbreak.ts.",
  }),
}) {}
