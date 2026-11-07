export * as RecoveryTools from "./tools.js"

import { randomUUID } from "node:crypto"
import { mkdir, readdir, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Tool } from "@orchestra/ai"
import { Effect, Schema } from "effect"

const MAX_READ_CHARS = 50_000
const MAX_SHELL_CHARS = 20_000
const MAX_SHELL_COMMAND_CHARS = 20_000
const MAX_LIST_ENTRIES = 200
const SHELL_TIMEOUT = "60 seconds"

const output = Schema.Struct({ success: Schema.Boolean, output: Schema.String })
type Output = typeof output.Type

/**
 * Resolve a requested path inside the repo root, lexically only. This is a
 * convenience for callers that already hold a trusted path — it is NOT the
 * security boundary: a symlink inside the root can point outside it, and
 * this function cannot see that. The tools below use `resolveInRootReal`.
 */
export function resolveInRoot(root: string, input: string): string | undefined {
  const resolved = path.resolve(root, input)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined
  return resolved
}

/**
 * Resolve a requested path inside the real repo root, following symlinks.
 * The root itself is realpath'd, then the nearest existing ancestor of the
 * target is realpath'd and the remaining segments re-appended — so a path
 * through a symlink that points outside the repo, and a not-yet-created
 * file under such a link, both resolve outside and are refused. Returns
 * undefined when the root does not exist or the target escapes it.
 */
export async function resolveInRootReal(root: string, input: string): Promise<string | undefined> {
  const realRoot = await realpath(root).catch(() => undefined)
  if (realRoot === undefined) return undefined
  const lexical = path.resolve(root, input)
  const segments: string[] = []
  let current = lexical
  while (true) {
    const real = await realpath(current).catch(() => undefined)
    if (real !== undefined) {
      const resolved = segments.length === 0 ? real : path.join(real, ...segments.reverse())
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return undefined
      return resolved
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    segments.push(path.basename(current))
    current = parent
  }
}

/**
 * Files the repair agent may never read or write, even inside the repo:
 * anything that can carry a secret, and anything the server itself owns.
 * Config files (`orchestra.json`, `opencode.json`) are on the list because
 * provider options there can carry arbitrary headers, including
 * `Authorization` — reading one hands the key to an external model
 * provider, writing one lets the agent swap the server's credentials.
 * A path outside the root counts as protected too, so the check is safe to
 * run on any resolved path.
 */
const PROTECTED_FILES = new Set(["orchestra.json", "orchestra.jsonc", "opencode.json", "opencode.jsonc"])
const PROTECTED_SEGMENTS = new Set([".git", ".ssh"])
const PROTECTED_BASENAMES: ReadonlyArray<RegExp> = [
  /^\.env(\..*)?$/,
  /^credentials/i,
  /secret/i,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /\.db(-wal|-shm)?$/,
  /\.sqlite\d?(-wal|-shm)?$/,
]

export function isProtectedPath(resolved: string, root: string): boolean {
  const relative = path.relative(root, resolved)
  if (relative.startsWith(`..${path.sep}`) || relative === "..") return true
  const segments = relative.split(path.sep)
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) return true
  const base = segments.at(-1) ?? ""
  if (PROTECTED_FILES.has(base)) return true
  return PROTECTED_BASENAMES.some((pattern) => pattern.test(base))
}

/** A path a tool may touch: inside the real root and not a protected file. */
async function resolveToolPath(
  root: string,
  input: string,
): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  const file = await resolveInRootReal(root, input)
  if (file === undefined)
    return { ok: false, reason: `Отказано: путь ${input} выходит за пределы репозитория.` }
  const realRoot = await realpath(root).catch(() => undefined)
  if (realRoot !== undefined && isProtectedPath(file, realRoot))
    return {
      ok: false,
      reason: `Отказано: ${input} — защищённый файл (секреты или служебные данные); его нельзя читать или править напрямую.`,
    }
  return { ok: true, file }
}

/**
 * Commands the repair agent may never run, even autonomously: destroying
 * the machine or the repo, wiping untracked work, force-pushing, piping
 * remote code into a shell, or fetching from / uploading to a remote host.
 * The list is a backstop, not the whole defence: the agent is autonomous
 * and its commands come from a model that can be steered by text it read
 * (prompt injection through files and logs), so every destructive shape
 * below is refused outright instead of trusted to the model's judgement.
 */
const FORBIDDEN_COMMANDS: ReadonlyArray<RegExp> = [
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\b/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  /\bfind\b[^|;&\n]*-delete\b/,
  /\bgit\s+clean\b[^|;&\n]*-[a-zA-Z]*f/,
  /\bgit\s+push\b[^|;&\n]*--force(?!-with-lease)\b/,
  /\bdd\b[^|;&\n]*\bof=/,
  /\|\s*(sh|bash|zsh|dash|ash|fish|pwsh|powershell|cmd)\b/,
  /\bchmod\b[^|;&\n]*\b777\b/,
  /\benv\b[^|;&\n]*\|\s*(curl|wget)\b/,
  /\b(curl|wget)\b[^|;&\n]*(-d\b|--data\b|--data-binary\b|--upload-file\b)/,
]

const REMOTE_HOSTS_OK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** `rm` with both recursive and force flags aimed at an absolute, home or variable path. */
function hasDangerousRm(command: string): boolean {
  for (const segment of command.split(/[|;&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const start = tokens[0] === "sudo" ? 1 : 0
    if (tokens[start] !== "rm") continue
    const rest = tokens.slice(start + 1)
    const flags = rest.filter((token) => token.startsWith("-") && token !== "--")
    const letters = flags.map((flag) => flag.replace(/^-+/, "")).join("")
    const longOpts = new Set(rest.filter((token) => token.startsWith("--")))
    const recursive = letters.includes("r") || longOpts.has("--recursive")
    const force = letters.includes("f") || longOpts.has("--force")
    if (!recursive || !force) continue
    const operands = rest.filter((token) => !token.startsWith("-") && token !== "--")
    if (operands.some((operand) => operand.startsWith("/") || operand.startsWith("~") || operand.startsWith("$")))
      return true
  }
  return false
}

/** `curl`/`wget` to a host that is not this machine. */
function hasRemoteFetch(command: string): boolean {
  for (const segment of command.split(/[|;&\n]+/)) {
    const trimmed = segment.trim()
    if (!/^(curl|wget)\b/.test(trimmed)) continue
    for (const match of trimmed.matchAll(/https?:\/\/([^\s/'":]+)/g)) {
      if (!REMOTE_HOSTS_OK.has(match[1]!.toLowerCase())) return true
    }
  }
  return false
}

export function isForbiddenCommand(command: string): boolean {
  return (
    FORBIDDEN_COMMANDS.some((pattern) => pattern.test(command)) ||
    hasDangerousRm(command) ||
    hasRemoteFetch(command)
  )
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
        const resolved = yield* Effect.promise(() => resolveToolPath(root, input.path))
        if (!resolved.ok) return { success: false, output: resolved.reason }
        const read = yield* Effect.tryPromise({
          try: () => Bun.file(resolved.file).text(),
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
        const resolved = yield* Effect.promise(() => resolveToolPath(root, input.path))
        if (!resolved.ok) return { success: false, output: resolved.reason }
        const file = resolved.file
        // Atomic publish: the content lands in a temp file in the same
        // directory first, then one rename moves it into place — a crash
        // mid-write never leaves a half-written file behind, and a reader
        // never sees a partial write.
        const written = yield* Effect.tryPromise({
          try: async () => {
            await mkdir(path.dirname(file), { recursive: true })
            const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
            try {
              await Bun.write(temporary, input.content)
              await rename(temporary, file)
            } catch (cause) {
              await unlink(temporary).catch(() => undefined)
              throw cause
            }
          },
          catch: (cause) => new Error(`Cannot write ${input.path}: ${cause instanceof Error ? cause.message : String(cause)}`),
        }).pipe(
          Effect.map(() => ({ success: true, output: `Записано: ${input.path} (${input.content.length} символов).` })),
          Effect.catch((cause) => Effect.succeed({ success: false, output: `Error: ${cause.message}` })),
        )
        return written
      }),
  })

  const listFiles = Tool.make({
    description: "List files and directories inside the Orchestra repository (paths are relative to the root).",
    parameters: Schema.Struct({ path: Schema.String.pipe(Schema.optional) }),
    success: output,
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.promise(() => resolveToolPath(root, input.path ?? "."))
        if (!resolved.ok) return { success: false, output: resolved.reason }
        const listed = yield* Effect.tryPromise({
          try: () => readdir(resolved.file, { withFileTypes: true }),
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
        if (input.command.length > MAX_SHELL_COMMAND_CHARS)
          return { success: false, output: `Отказано: команда длиннее ${MAX_SHELL_COMMAND_CHARS} знаков.` }
        if (isForbiddenCommand(input.command))
          return { success: false, output: `Отказано: команда запрещена (разрушительная): ${input.command}` }
        // The shell runs in the real repo root, not the server's working
        // directory: a symlinked cwd would let relative paths escape.
        const realRoot = yield* Effect.promise(() => realpath(root).catch(() => undefined))
        if (realRoot === undefined)
          return { success: false, output: "Отказано: корень репозитория недоступен." }
        const argv =
          process.platform === "win32"
            ? [process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", input.command]
            : ["sh", "-c", input.command]
        const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: realRoot, windowsHide: true })
        const waited = yield* Effect.tryPromise({
          try: () => Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
          catch: () => new Error("shell failed"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: SHELL_TIMEOUT,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.onInterrupt(() => Effect.sync(() => child.kill())),
          Effect.orElseSucceed(() => undefined),
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
