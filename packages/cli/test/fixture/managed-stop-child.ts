// Runs only in a subprocess whose env/cwd/roots are isolated before this module is imported.
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { writeSync } from "node:fs"
import path from "node:path"
import { runProbed } from "../../src/server-process-test"
import { ORCHESTRA_CHANNEL } from "../../src/version"
import { ServiceConfig } from "../../src/services/service-config"
const phase = process.argv[2]
const emit = (stage: string) =>
  writeSync(
    1,
    "PROBE " +
      JSON.stringify({
        stage,
        file: path.join(process.env.XDG_STATE_HOME!, "orchestra", ServiceConfig.filename(ORCHESTRA_CHANNEL)),
      }) +
      "\n",
  )
runProbed(
  { mode: "service", port: Number(process.argv[3] ?? 0) },
  {
    beforeManagedBoot: Effect.sync(() => emit("early")).pipe(
      Effect.andThen(phase === "early" ? Effect.never : Effect.void),
    ),
    afterManagedStart: Effect.sync(() => emit("post-boot")),
  },
).pipe(
  Effect.tapCause((cause) => Effect.sync(() => writeSync(2, String(cause) + "\n"))),
  NodeRuntime.runMain({ disableErrorReporting: false }),
)
