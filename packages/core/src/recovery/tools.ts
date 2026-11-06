export * as RecoveryTools from "./tools.js"

import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { Tool } from "@orchestra/ai"
import { Effect, Schema } from "effect"

const MAX_READ_CHARS = 50_000
const MAX_SHELL_CHARS = 20_000
const MAX_LIST_ENTRIES = 200
const SHELL_TIMEOUT = "60 seconds"

const output = Schema.Struct({ success: Schema.Boolean, output: Schema.String })
type Output = typeof output.Type

/** Resolve a requested path inside the repo root; undefined when it escapes the root. */
export function resolveInRoot(root: string, input: string): string | undefined {
  const resolved = path.resolve(root, input)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined
  return resolved
}

/** Commands the repair agent may never run, even autonomously: destroying the machine or the repo. */
const FORBIDDEN_COMMANDS: ReadonlyArray<RegExp> = [
  /\brm\s+[^|;&]*-rf\s+\/\s*(?:$|[;&])/,
  /\brm\s+[^|;&]*-rf\s+~/,
  /\brm\s+[^|;&]*-rf\s+\$HOME/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
]

export function isForbiddenCommand(command: string): boolean {
  return FORBIDDEN_COMMANDS.some((pattern) => pattern.test(command))
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n\n[... truncated: ${text.length - max} more characters ...]`

/** The four tools the repair agent gets: read, write and list files, run a shell command. */
export const recoveryTools = (root: string) => {
  const readFile = Tool.make({
    description: "Read a text file inside the Orchestra repository (paths are relative to the repo root).",
    parameters: Schema.Struct({ path: Schema.String }),
    success: output,
    execute: (input) =>
      Effect.gen(function* () {
        const file = resolveInRoot(root, input.path)
        if (!file) return { success: false, output: `Отказано: путь ${input.path} выходит за пределы репозитория.` }
        const read = yield* Effect.tryPromise({
          try: () => Bun.file(file).text(),
          catch: (cause) => new Error(`Cannot read ${input.path}: ${cause instanceof Error ? cause.message : String(cause)}`),
        }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((cause) => Effect.succeed({ ok: false as const, message: cause.message })),
        )
        if (!read.ok) return { success: false, output: `Error: ${read.message}` }
        return { success: true, output: truncate(read.value, MAX_READ_CHARS) }
      }),
  })

  const writeFile = Tool.make({
    description: "Write a text file inside the Orchestra repository (paths are relative to the repo root). Creates parent directories.",
    parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
    success: output,
    execute: (input) =>
      Effect.gen(function* () {
        const file = resolveInRoot(root, input.path)
        if (!file) return { success: false, output: `Отказано: путь ${input.path} выходит за пределы репозитория.` }
        if (file.includes(`${path.sep}.git${path.sep}`) || /\.db(-wal|-shm)?$/.test(file))
          return { success: false, output: `Отказано: ${input.path} нельзя править напрямую (используй git или API).` }
        yield* Effect.tryPromise({
          try: () => mkdir(path.dirname(file), { recursive: true }),
          catch: () => new Error("mkdir failed"),
        }).pipe(Effect.catch(() => Effect.void))
        const written = yield* Effect.tryPromise({
          try: () => Bun.write(file, input.content),
          catch: (cause) => new Error(`Cannot write ${input.path}: ${cause instanceof Error ? cause.message : String(cause)}`),
        }).pipe(
          Effect.map(() => ({ success: true, output: `Записано: ${input.path} (${input.content.length} символов).` })),
          Effect.catch((cause) => Effect.succeed({ success: false, output: `Error: ${cause.message}` })),
        )
        return written
      }),
  })

  const listFiles = Tool.make({
    description: "List files and directories inside the Orchestra repository (paths are relative to the repo root).",
    parameters: Schema.Struct({ path: Schema.String.pipe(Schema.optional) }),
    success: output,
    execute: (input) =>
      Effect.gen(function* () {
        const dir = resolveInRoot(root, input.path ?? ".")
        if (!dir) return { success: false, output: `Отказано: путь ${input.path} выходит за пределы репозитория.` }
        const listed = yield* Effect.tryPromise({
          try: () => readdir(dir, { withFileTypes: true }),
          catch: (cause) => new Error(`Cannot list ${input.path ?? "."}: ${cause instanceof Error ? cause.message : String(cause)}`),
        }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((cause) => Effect.succeed({ ok: false as const, message: cause.message })),
        )
        if (!listed.ok) return { success: false, output: `Error: ${listed.message}` }
        const lines = listed.value
          .slice(0, MAX_LIST_ENTRIES)
          .map((entry) => `${entry.isDirectory() ? "dir  " : "file "} ${entry.name}`)
        return { success: true, output: lines.join("\n") || "(пусто)" }
      }),
  })

  const runShell = Tool.make({
    description: "Run a shell command inside the Orchestra repository (60 second timeout). Use it to run tests, builds and git.",
    parameters: Schema.Struct({ command: Schema.String }),
    success: output,
    execute: (input) =>
      Effect.gen(function* () {
        if (isForbiddenCommand(input.command))
          return { success: false, output: `Отказано: команда запрещена (разрушительная): ${input.command}` }
        const argv =
          process.platform === "win32"
            ? [process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", input.command]
            : ["sh", "-c", input.command]
        const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: root, windowsHide: true })
        const waited = yield* Effect.tryPromise({
          try: () => Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
          catch: () => new Error("shell failed"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: SHELL_TIMEOUT,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.onInterrupt(() => Effect.sync(() => child.kill())),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (waited === undefined)
          return { success: false, output: "Команда не завершилась за 60 секунд и была остановлена." }
        const [exit, stdout, stderr] = waited
        const body = [`exit: ${exit}`, `stdout:\n${truncate(stdout, MAX_SHELL_CHARS)}`, `stderr:\n${truncate(stderr, MAX_SHELL_CHARS)}`].join("\n")
        return { success: exit === 0, output: body }
      }),
  })

  return { read_file: readFile, write_file: writeFile, list_files: listFiles, run_shell: runShell }
}

export type RecoveryToolOutput = Output
