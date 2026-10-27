import path from "path"
import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "@orchestra/schema/location"
import { AbsolutePath } from "./schema.js"
import { Project } from "./project.js"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode, tags } from "@orchestra/util/effect/app-node"

export * as Location from "./location.js"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

/**
 * Asserts that a location directory path is valid, absolute, and safe from path traversal attacks.
 */
export function assertSafePath(input: string): string {
  if (!input || typeof input !== "string") {
    throw new Error("Location path cannot be empty")
  }
  if (input.includes("\0")) {
    throw new Error(`Location path traversal detected: null-byte in '${input}'`)
  }
  // Disallow DOS device names on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (process.platform === "win32") {
    const devicePattern = /(?:^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$|[\\/])/i
    if (devicePattern.test(input)) {
      throw new Error(`Location path traversal detected: reserved device name in '${input}'`)
    }
    // Disallow drive-relative paths (e.g. C:foo without slash)
    if (/^[a-zA-Z]:[^/\\]/.test(input)) {
      throw new Error(`Location path invalid: drive-relative path '${input}' requires leading separator`)
    }
  }
  return normalizePath(input)
}

/**
 * Normalizes a location path safely while preserving platform-appropriate semantics.
 */
export function normalizePath(input: string): string {
  if (process.platform === "win32") {
    if (/^[a-zA-Z]:[/\\]/.test(input) || /^[/\\]{2}/.test(input) || input.includes("\\")) {
      return path.win32.normalize(input)
    }
    return path.posix.normalize(input)
  }
  return path.posix.normalize(input)
}

export function sanitizePath(input: string): AbsolutePath {
  const safe = assertSafePath(input)
  return AbsolutePath.make(safe)
}

const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const safeDirectory = sanitizePath(ref.directory)
      const project = yield* Project.Service
      const resolved = yield* project.resolve(safeDirectory)
      return Service.of({
        directory: safeDirectory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
        vcs: resolved.vcs,
      })
    }),
  )

export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node],
  })
