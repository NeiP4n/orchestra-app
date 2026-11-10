export * as CapabilityOutcomesPlugin from "./capability-outcomes.js"
import { define } from "@orchestra/plugin/effect/plugin"
import { Effect } from "effect"
import { CapabilityCapture } from "../capabilities/capture.js"
import { hubGroup, mcpGroup } from "../capabilities/registry.js"
import { all as hub } from "../hub/catalog/index.js"
import { KV } from "../kv.js"
import { Mcp } from "../mcp/index.js"
import { Orchestra } from "../orchestra.js"
import { namespace } from "../tool/mcp.js"

/** Local numeric telemetry only. Does not change tool permissions, DoD, verifier rules, or choices.
 * Records only explicitly owned sessions; no directory-name fallback or project:unknown bucket. */
export const Plugin = define({
  id: "orchestra.capability-outcomes",
  effect: Effect.fn("CapabilityOutcomesPlugin")(function* (ctx) {
    const kv = yield* KV.Service
    const orchestra = yield* Orchestra.Service
    const mcp = yield* Mcp.Service
    const capture = CapabilityCapture.make(kv)
    const quiet = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause(() => Effect.logWarning("Capability attempt observation was not recorded.")),
      )
    yield* ctx.tool.hook("execute.before", (event) =>
      quiet(
        Effect.gen(function* () {
          const owners = yield* orchestra.owners()
          const projects = yield* orchestra.projects()
          const owned = owners[event.sessionID]
          const project = owned
            ? projects.find((row) => row.id === owned)
            : projects.find((row) => row.main === event.sessionID)
          if (!project) return
          const registered = (yield* ctx.tool.list()).find((row) => row.id === event.tool)
          if (!registered) return
          let attribution = CapabilityCapture.localAttribution(project.id, event.tool)
          if (event.tool === "hub") {
            const candidate =
              event.input && typeof event.input === "object" && "id" in event.input ? event.input.id : undefined
            const entry = hub.find((row) => row.id === candidate)
            if (!entry || "list" in (event.input as object) || "install" in (event.input as object)) return
            attribution = { projectID: project.id, adapterID: "hub:" + entry.id, capability: hubGroup(entry.category) }
          } else if (registered.options?.namespace) {
            const matches = (yield* mcp.servers()).filter(
              (row) => namespace(row.name) === registered.options?.namespace,
            )
            if (matches.length > 1) return // normalized namespace collision, cannot attribute safely
            if (matches[0])
              attribution = {
                projectID: project.id,
                adapterID: "mcp:" + matches[0].name,
                capability: mcpGroup(matches[0].name),
              }
          }
          yield* capture.begin(event, attribution)
        }),
      ),
    )
    yield* ctx.tool.hook("execute.after", (event) => quiet(capture.end(event)))
  }),
})
