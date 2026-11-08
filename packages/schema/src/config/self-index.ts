export * as ConfigSelfIndex from "./self-index.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("ConfigSelfIndex.Info")({
  paths: Schema.Array(Schema.String).pipe(optional).annotate({
    description:
      "Extra markdown or text files of the operator's own that the self index includes, so the agent knows them too",
  }),
  docs: Schema.Boolean.pipe(optional).annotate({
    description: "Include Orchestra's own AI_ATLAS.md and AGENTS.md sections in the self index (default on)",
  }),
}) {}
