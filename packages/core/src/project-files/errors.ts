export * as ProjectFilesErrors from "./errors.js"

import { Schema } from "effect"

/**
 * One error for every project-file failure. A corrupt file is never read as
 * an empty file, a missing file is never read as a default, and a divergence
 * between a file and the database is never swallowed: each one fails loudly
 * with the file path and the reason, so the caller (and health.json) can
 * name the broken file instead of guessing.
 */
export class ProjectFileError extends Schema.TaggedError<ProjectFileError>()("ProjectFiles.Error", {
  file: Schema.String,
  kind: Schema.Literals(["corrupt", "missing", "divergent", "write-failed", "restore-failed", "invalid"]),
  message: Schema.String,
}) {}

export const corrupt = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "corrupt", message })

export const missing = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "missing", message })

export const divergent = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "divergent", message })

export const writeFailed = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "write-failed", message })

export const restoreFailed = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "restore-failed", message })

export const invalid = (file: string, message: string): ProjectFileError =>
  new ProjectFileError({ file, kind: "invalid", message })
