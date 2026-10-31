// Compact answers for the model: a save is one line plus the paths, a list is one line per snapshot,
// a preview is what a restore would do. Everything is clipped to the tool's context budget.

import type { GcReport, Moment, Preview, RestoreReport } from "./types.js"

export const LIMIT = 2048
const PATHS = 24

export function renderSave(moment: Moment) {
  return clip(
    [
      `Saved "${moment.name}" (${moment.id}) — ${count(moment.files.length, "file")}, ${size(moment.bytes)} → ${size(moment.stored)}`,
      ...moment.files.slice(0, PATHS).map((file) => `  ${sign(file.kind)}  ${file.path}`),
      ...(moment.files.length > PATHS ? [`  ... and ${moment.files.length - PATHS} more`] : []),
    ].join("\n"),
  )
}

export function renderList(moments: readonly Moment[]) {
  if (moments.length === 0) return "No checkpoints yet. `checkpoint save` records the changed paths of the project."
  return clip(
    [
      `${count(moments.length, "checkpoint")}:`,
      ...moments
        .slice(0, PATHS)
        .map(
          (moment) =>
            `  ${moment.id}  "${moment.name}"  ${new Date(moment.created).toISOString().slice(0, 16).replace("T", " ")}  ${count(moment.files.length, "file")}  ${size(moment.stored)}`,
        ),
      ...(moments.length > PATHS ? [`  ... and ${moments.length - PATHS} more`] : []),
    ].join("\n"),
  )
}

export function renderPreview(preview: Preview) {
  const { moment } = preview
  const lines = [
    `Restoring "${moment.name}" (${moment.id}) would write ${preview.writes}, delete ${preview.deletes}, leave ${preview.unchanged} unchanged`,
    ...preview.files
      .filter((file) => file.action !== "unchanged")
      .slice(0, PATHS)
      .map((file) => `  ${file.action === "write" ? "+" : "-"}  ${file.path}`),
    ...(preview.extra.length > 0
      ? [
          `${count(preview.extra.length, "changed path")} not in the snapshot stay untouched: ${preview.extra.slice(0, 5).join(", ")}${preview.extra.length > 5 ? ", ..." : ""}`,
        ]
      : []),
  ]
  return clip(lines.join("\n"))
}

export function renderRestore(report: RestoreReport) {
  return clip(
    [
      `Restored "${report.moment.name}" (${report.moment.id}): ${report.written} written, ${report.deleted} deleted, ${report.unchanged} unchanged`,
      ...(report.safety === undefined
        ? []
        : [`The working tree before the restore is "${report.safety}"; restore it to undo this.`]),
    ].join("\n"),
  )
}

export function renderGc(report: GcReport) {
  return `Collected ${count(report.removed, "unused object")}, kept ${report.kept}.`
}

export function renderRemove(moment: Moment) {
  return `Removed "${moment.name}" (${moment.id}). Its objects stay until gc collects the unreferenced ones.`
}

function sign(kind: Moment["files"][number]["kind"]) {
  if (kind === "deleted") return "-"
  if (kind === "added" || kind === "untracked") return "+"
  if (kind === "renamed") return ">"
  return "~"
}

function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clip(text: string, limit = LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}
