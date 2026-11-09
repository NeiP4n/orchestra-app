export * as RulesTool from "./rules.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Federation } from "../../federation.js"
import { KV } from "../../kv.js"
import { Orchestra } from "../../orchestra.js"
import { RuleEnforce } from "../../rule-enforce.js"
import { Rules } from "../../rules.js"
import { Tool } from "@orchestra/schema/tool"
import { Session } from "../../session.js"

export const name = "rules"

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "add", "remove", "violations"]),
  text: Schema.optionalKey(Schema.String).annotate({
    description: `For add: the rule, one short sentence (at most ${Rules.MAX_TEXT} characters), written so any teammate can follow it without context.`,
  }),
  scope: Schema.optionalKey(Schema.Literals(["project", "society", "session", "role"])).annotate({
    description:
      "For add: project binds this project's team; society binds the whole Society (its chat and every project in it); session binds one session (yours, or another one when you are the Orchestrator: pass session); role binds every session of one role (Orchestrator only: pass role). Default: the Society in a Society chat, otherwise the project.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "For remove: the rule's id, from list." }),
  session: Schema.optionalKey(Schema.String).annotate({ description: "Orchestrator only: the other session whose rules to add to, list or remove from." }),
  role: Schema.optionalKey(Schema.String).annotate({ description: "Orchestrator only: the role (agent name) whose rules to add to, list or remove from." }),
})
export const Output = Schema.Struct({ output: Schema.String })

const description = [
  "The rulebook: standing rules this crew keeps. Add a rule when you learn something every teammate must follow (a convention, something never to do, a decision that settles a debate); it is then part of everyone's instructions without being repeated in briefs.",
  "Actions: list (the rules that apply to you, with ids), add, remove, violations (the latest refused calls and judged breaks). A rule written as `deny tool <glob> [for role <glob>]`, `only role <glob> may use tool <glob>`, `deny command <regex> [for role <glob>]` or `deny path <glob> [for role <glob>]` is enforced by code: a call that breaks it is refused with the rule's text.",
  "Other rules are checked at the end of a turn by a light judge and send the agent back to work.",
  " Keep rules short and few; remove one that is obsolete. Never add a rule that contradicts the operator.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.rules",
  effect: Effect.fn("RulesTool.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const sessions = yield* Session.Service
    const orchestra = yield* Orchestra.Service
    const federation = yield* Federation.Service

    // The hard layer: one check before every tool call, against the rules this session carried on its latest request.
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const entries = RuleEnforce.recall(String(event.sessionID))
        const broken = RuleEnforce.violation(entries, { tool: event.tool, agent: String(event.agent), input: event.input })
        if (!broken) return
        RuleEnforce.log({
          layer: "hard",
          outcome: "refused",
          session: String(event.sessionID),
          agent: String(event.agent),
          rule: broken.text,
          by: broken.by,
          what: `${event.tool} ${JSON.stringify(event.input ?? {}).slice(0, 200)}`,
        })
        return yield* new Tool.Error({ message: RuleEnforce.refusal(broken) })
      }),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          // Loaded on demand: the rules block every request carries names the tool, so a model that wants it asks for it.
          options: { codemode: false, triggers: ["rule|правил"] },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const scopes = yield* Rules.scopesOf({ sessionID: context.sessionID, sessions, orchestra, federation })
              const mine = [
                ...scopes.societies.map((society) => ({ kind: "society" as const, scope: Rules.societyScope(society), label: `Society ${society}` })),
                ...(scopes.project ? [{ kind: "project" as const, scope: Rules.projectScope(scopes.project), label: "Project" }] : []),
                // Operator rules on the Orchestrator ride on its every turn; only the operator removes them.
                ...(scopes.orchestrator && scopes.project
                  ? [{ kind: "orchestrator" as const, scope: Rules.orchestratorScope(scopes.project), label: "Orchestrator" }]
                  : []),
                ...(scopes.project && scopes.role
                  ? [{ kind: "role" as const, scope: Rules.roleScope(scopes.project, scopes.role), label: `Role ${scopes.role}` }]
                  : []),
                ...(scopes.session ? [{ kind: "session" as const, scope: Rules.sessionScope(scopes.session), label: "This session" }] : []),
                { kind: "global" as const, scope: Rules.GLOBAL, label: "Global" },
              ]
              // The Orchestrator hands rules to other sessions and roles of its project; nobody else reaches them.
              const reach: Array<{ kind: "session" | "role"; scope: string; label: string }> = []
              if (input.session || input.role) {
                if (!scopes.orchestrator || !scopes.project)
                  return yield* new ToolFailure({ message: "Only the Orchestrator can write or read rules of another session or role." })
                if (input.session)
                  reach.push({ kind: "session", scope: Rules.sessionScope(input.session), label: `Session ${input.session}` })
                if (input.role)
                  reach.push({ kind: "role", scope: Rules.roleScope(scopes.project, input.role), label: `Role ${input.role}` })
              }

              if (input.action === "violations") {
                const lines = RuleEnforce.recent(15)
                return { output: lines.length ? lines.join("\n") : "No rule violations logged." }
              }

              if (input.action === "list") {
                // Inherited scopes are read-only: a sandbox session sees the source's rules
                // because they bind it, but it never adds or removes them.
                const visible = [
                  ...mine,
                  ...reach,
                  ...(scopes.inherited?.societies ?? []).map((society) => ({
                    kind: "inherited" as const,
                    scope: Rules.societyScope(society),
                    label: `Society ${society} (inherited)`,
                  })),
                  ...(scopes.inherited?.projects ?? []).map((project) => ({
                    kind: "inherited" as const,
                    scope: Rules.projectScope(project),
                    label: "Project (inherited)",
                  })),
                ]
                const lines = yield* Effect.forEach(visible, (entry) =>
                  Rules.inspect(kv, entry.scope).pipe(
                    Effect.map((found) => [
                      ...found.rules.map((rule) => `- ${rule.id} [${entry.label}] ${rule.text} (${rule.by})`),
                      ...(found.corrupt > 0
                        ? [
                            `! ${entry.label}: ${found.corrupt} stored rule ${found.corrupt === 1 ? "entry is" : "entries are"} corrupt and were not loaded. Ask the operator to fix them.`,
                          ]
                        : []),
                    ]),
                  ),
                )
                const all = lines.flat()
                return { output: all.length ? all.join("\n") : "No rules apply yet." }
              }

              if (input.action === "remove") {
                if (!input.id) return yield* new ToolFailure({ message: "remove needs id, from list." })
                let protectedReason: string | undefined
                for (const entry of [...mine, ...reach]) {
                  // The operator's global rules are theirs to change, and so is any rule the
                  // operator wrote in another scope: a worker cannot delete the operator's orders.
                  if (entry.kind === "global") continue
                  const removed = yield* Rules.remove(kv, entry.scope, input.id).pipe(
                    Effect.catchTag("Rules.ProtectedError", (error) =>
                      Effect.sync(() => {
                        protectedReason = error.reason
                        return false
                      }),
                    ),
                  )
                  if (removed) return { output: `Removed ${input.id}.` }
                }
                return yield* new ToolFailure({
                  message:
                    protectedReason ??
                    "No rule of yours has that id. Global rules are changed only by the operator.",
                })
              }

              const text = input.text?.trim()
              if (!text) return yield* new ToolFailure({ message: "add needs text." })
              const wanted = input.scope ?? (input.session ? "session" : input.role ? "role" : scopes.chatOf ? "society" : "project")
              const wantSociety = wanted === "society"
              // Orchestrator rules are the operator's to write; an AI cannot put a rule on its own Orchestrator.
              const target =
                wanted === "session"
                  ? (reach.find((entry) => entry.kind === "session") ?? mine.find((entry) => entry.kind === "session"))
                  : wanted === "role"
                    ? reach.find((entry) => entry.kind === "role")
                    : wantSociety
                      ? mine.find((entry) => entry.kind === "society")
                      : mine.find((entry) => entry.kind === "project")
              if (!target)
                return yield* new ToolFailure({
                  message: wantSociety ? "This session is not part of a Society." : "This session works for no project.",
                })
              // A new rule that contradicts a higher scope is refused here, in code: society
              // beats project beats global, and the model never picks a winner.
              const higher = mine.filter((entry) => entry.scope !== target.scope && scopeRank(entry.scope) < scopeRank(target.scope))
              const higherRules = (yield* Effect.forEach(higher, (entry) => Rules.list(kv, entry.scope))).flat()
              const conflict = Rules.findConflict(text, higherRules)
              if (conflict)
                return yield* new ToolFailure({
                  message: `That rule contradicts a higher-scope rule: "${conflict.text}". Society rules override project rules, which override global rules; rewrite it so it does not contradict the higher rule.`,
                })
              const added = yield* Rules.add(kv, target.scope, { text, by: context.agent })
              if (!("rule" in added) || !added.rule) return yield* new ToolFailure({ message: String("error" in added ? added.error : "Could not add the rule.") })
              return { output: `Added ${added.rule.id} to ${target.label}: ${added.rule.text}` }
            }).pipe(
              Effect.map((result) => ({ output: result, content: result.output })),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `rules failed: ${String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

// Society outranks project, project outranks global; a lower number is a higher scope.
const scopeRank = (scope: string) =>
  scope.startsWith("society:") ? 0 : scope.startsWith("project:") ? 1 : scope.startsWith("orchestrator:") ? 2 : scope.startsWith("role:") ? 3 : scope.startsWith("session:") ? 4 : 5
