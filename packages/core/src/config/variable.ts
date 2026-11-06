export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@orchestra/util/fs-util"
import { InvalidError } from "../v1/config/error.js"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
}

export type { SubstituteInput }

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  // A missing variable fails loudly by default: an empty string here is how
  // a provider once started with an empty key and died only on its first
  // request with a 401 (N-02). Callers that genuinely want "missing means
  // empty" pass missing: "empty" — the same opt-out the {file:} branch has.
  const missing: Array<string> = []
  const text = input.text.replace(/\{env:([^}]+)\}/g, (token: string, varName: string) => {
    const value = input.env?.[varName] ?? process.env[varName]
    if (value === undefined) {
      if (input.missing === "empty") return ""
      missing.push(varName)
      return token
    }
    return value
  })
  if (missing.length > 0) {
    const names = [...new Set(missing)]
    const source = input.type === "path" ? input.path : input.source
    return yield* Effect.fail(
      new InvalidError({
        path: source,
        message: `missing environment variable${names.length > 1 ? "s" : ""}: ${names.join(", ")} (referenced as {env:...} in ${source}; export the variable or pass missing: "empty" to allow an empty value)`,
      }),
    )
  }
  if (!text.includes("{file:")) return text
  return yield* substituteFiles(input, text)
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((error) => {
        if (input.missing === "empty") return Effect.succeed("")

        const message = `bad file reference: "${token}"`
        return Effect.fail(
          new InvalidError(
            {
              path: configSource,
              message:
                error._tag === "PlatformError" && error.reason._tag === "NotFound"
                  ? `${message} ${resolvedPath} does not exist`
                  : message,
            },
            { cause: error },
          ),
        )
      }),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})
