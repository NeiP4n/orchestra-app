export * as SandboxPlugin from "./sandbox.js"

import path from "node:path"
import { define } from "@orchestra/plugin/effect/plugin"
import type { ShellCreateBefore } from "@orchestra/plugin/effect/shell"
import { Effect } from "effect"
import { Orchestra } from "../orchestra.js"

// Confines every shell command started inside a sandbox project. The command gets the sandbox's
// own opencode roots, so a nested `opencode` reads the sandbox's empty service registration and
// database instead of reaching the live service. Strict isolation also runs it under bubblewrap.
export const Plugin = define({
  id: "opencode.sandbox",
  effect: Effect.fn(function* (ctx) {
    const orchestra = yield* Orchestra.Service
    yield* ctx.shell.hook("create.before", (event) =>
      Effect.gen(function* () {
        const sandbox = (yield* orchestra.projects()).find(
          (project) => project.sandbox && Orchestra.contains(project.directory, event.cwd),
        )?.sandbox
        if (!sandbox) return
        const home = event.env.HOME
        event.env = environment(event.env, sandbox.home)
        if (sandbox.isolation === "strict") event.command = confine(event, sandbox, home)
      }),
    )
  }),
})

export function environment(env: ShellCreateBefore["env"], home: string): ShellCreateBefore["env"] {
  return {
    // Anything the live server passes down (its password, database or config overrides) must not
    // leak into the sandbox; only the terminal marker set by the shell service is kept.
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("ORCHESTRA_") || key === "ORCHESTRA_TERMINAL"),
    ),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  }
}

// Hides the user's home (credentials, the live service registration, the source checkout) and
// allows writes only to the sandbox home and the source repository's git directory, which the
// worktree's refs and index live in. Bun stays readable, and its install cache writable.
export function confine(event: ShellCreateBefore, sandbox: Orchestra.Sandbox, home: string | undefined) {
  const args = [
    "bwrap",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...(home
      ? [
          "--tmpfs",
          home,
          "--ro-bind-try",
          path.join(home, ".bun"),
          path.join(home, ".bun"),
          "--bind-try",
          path.join(home, ".bun", "install", "cache"),
          path.join(home, ".bun", "install", "cache"),
        ]
      : []),
    "--bind",
    sandbox.home,
    sandbox.home,
    "--bind",
    path.join(sandbox.source, ".git"),
    path.join(sandbox.source, ".git"),
    "--chdir",
    event.cwd,
    "--",
    event.shell,
    "-c",
    event.command,
  ]
  return "exec " + args.map(quote).join(" ")
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
