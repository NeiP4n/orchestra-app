export * as VaultTool from "./vault.js"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { Effect, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Session } from "../../session.js"
import { Orchestra as OrchestraService } from "../../orchestra.js"
import { CredentialVault } from "../../credential-vault/index.js"
import { VaultAccess } from "../../credential-vault/access.js"
import { httpSummary } from "../../credential-vault/http.js"
export const name = "vault"
export const Input = Schema.Struct({
  action: Schema.Literals(["list", "request", "check_http"]),
  name: Schema.optionalKey(Schema.String),
  site: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
})
export const Output = Schema.Struct({ output: Schema.String })
export const SECRET_GUIDE =
  "Secrets (API keys, tokens, passwords) must NEVER be requested in chat or stored in .env, project files, logs, tool input or model context. Use vault action=request with a nonsecret name and HTTPS site: it opens a masked native operator form, saves DPAPI ciphertext, and returns only the secret name. list shows names for this project. Never ask the user to paste a secret. check_http references that name; the fixed native HTTPS GET to savedBase/models only injects Bearer auth without returning plaintext, body or response headers. OFF until the operator enables this exact chat/project in Security. No general shell/env injection: arbitrary commands can leak secrets. Choose normal implementation details yourself; only operator-only effects need a decision."
export const Plugin = {
  id: "orchestra.tool.vault",
  effect: Effect.fn("VaultTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const orchestra = yield* OrchestraService.Service
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        event.system.push({ type: "text", text: SECRET_GUIDE })
      }),
    )
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          input: Input,
          output: Output,
          description: SECRET_GUIDE,
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions
                  .get(context.sessionID)
                  .pipe(Effect.mapError(() => new ToolFailure({ message: "Vault session is unavailable." }))),
                projectID = Orchestra.sessionOwner(session.metadata)
              if (!projectID) return yield* new ToolFailure({ message: "Vault requires a verified project owner." })
              const main = yield* orchestra
                .mainOf(context.sessionID)
                .pipe(
                  Effect.mapError(
                    () =>
                      new ToolFailure({
                        message: "Vault orchestrator verification failed; no operation was performed.",
                      }),
                  ),
                )
              if (!main || String(main.id) !== projectID || String(main.main) !== String(context.sessionID))
                return yield* new ToolFailure({
                  message:
                    "Vault operations are restricted to this project's main Orchestrator. Ask the Orchestrator; worker agents cannot list, collect or use secrets.",
                })
              const scope: VaultAccess.Scope = {
                sessionID: String(context.sessionID),
                projectID,
                directory: session.location.directory,
              }
              const vault = CredentialVault.local(projectID)
              const output = yield* Effect.tryPromise({
                try: async () => {
                  if (input.action === "list") return JSON.stringify(await vault.list())
                  if (!input.name?.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name))
                    throw Error("Pass a nonsecret Vault name (1-80 characters).")
                  if (input.action === "request") {
                    const site = new URL(input.site ?? "")
                    if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash)
                      throw Error("Pass the exact HTTPS site, never a secret or query string.")
                    const entries = await vault.list()
                    if (entries.some((entry) => entry.name === input.name))
                      return `Vault name already exists: ${input.name}. Use check_http; do not collect again.`
                    const saved = await vault.writeFromOperator(undefined, undefined, undefined, {
                      name: input.name!,
                      site: site.href,
                    })
                    return saved
                      ? `Saved Vault name: ${saved.name}. Value not returned; HTTP injection remains subject to the operator's exact-chat switch.`
                      : "Masked input cancelled; nothing saved."
                  }
                  const result = httpSummary(await vault.checkHttp(input.name!, input.url ?? "", scope))
                  return JSON.stringify({ ...result, body: "withheld", headers: "withheld", secret: "not returned" })
                },
                catch: () =>
                  new ToolFailure({
                    message:
                      "Vault action failed or is OFF. Verify this project's name and exact saved HTTPS site, enable HTTP in Security if intended, and use the masked native form. No plaintext fallback or raw errors returned.",
                  }),
              })
              return { output: { output }, content: output }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
