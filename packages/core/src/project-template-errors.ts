export const templateStages = ["project", "vault", "browser-links", "process-source", "roles", "playbook", "skills", "programs", "library-read", "library-write", "reservation", "source-read", "session-models", "skill-graph", "skill-files", "source-stability", "base-project", "base-sessions", "base-browsers", "base-rules", "base-schedules", "base-vault", "base-integrations", "base-schema", "process-bindings", "process-roles", "process-playbook", "process-skills", "process-assignments", "process-models", "process-programs", "process-schema"] as const
export type TemplateStage = typeof templateStages[number]
export const templateReasons = ["read-failed", "metadata-invalid", "path-not-portable", "secret-like", "schema-invalid", "dependency-missing", "dependency-cycle", "source-changed", "role-missing", "ownership-invalid", "browser-chat-missing", "browser-chat-child", "browser-chat-foreign", "browser-chat-unlisted", "unsupported-schedule", "file-missing", "permission-denied", "unsafe-file", "size-limit"] as const
export type TemplateReason = typeof templateReasons[number]
export interface TemplateDiagnostic { stage: TemplateStage; reasonCode: TemplateReason }
const diagnosticReason = (error: unknown): TemplateReason => {
  if (!(error instanceof Error)) return "read-failed"
  const code = (error as NodeJS.ErrnoException).code
  if (["EACCES", "EPERM", "EROFS"].includes(code ?? "")) return "permission-denied"
  if (code === "ENOENT") return "file-missing"
  const message = error.message
  if (message === "Absolute paths are not portable. No template was prepared.") return "path-not-portable"
  if (message === "Secret-like value detected. No template was prepared.") return "secret-like"
  if (message === "Skill dependencies contain a cycle.") return "dependency-cycle"
  if (message === "An assigned skill definition is missing.") return "dependency-missing"
  if (message === "Skill definition files cannot be captured safely. No template was prepared.") return "unsafe-file"
  if (message === "Process definitions changed during capture. Review them again." || message === "Project changed during capture.") return "source-changed"
  if (["Session fallback model metadata is damaged.", "Rule metadata is damaged.", "Session configuration changed during process capture."].includes(message)) return "metadata-invalid"
  if (["Invalid project template configuration or unsupported fields.", "Invalid process template or unsupported fields."].includes(message)) return "schema-invalid"
  if (["Project template exceeds the size limit.", "Formatted template exceeds the size limit.", "Process template exceeds the size limit.", "Formatted process template exceeds the size limit."].includes(message)) return "size-limit"
  return "read-failed"
}
export class TemplateStageError extends Error {
  readonly reasonCode: TemplateReason
  constructor(readonly stage: TemplateStage, readonly original: unknown, reasonCode?: TemplateReason) {
    super("Template stage failed")
    this.reasonCode = reasonCode ?? diagnosticReason(original)
  }
}
/** Only code-owned literals cross the log boundary, never source text or exception fields. */
export function templateDiagnosticOf(error: unknown): TemplateDiagnostic | undefined {
  if (!(error instanceof TemplateStageError) || !templateStages.includes(error.stage) || !templateReasons.includes(error.reasonCode)) return
  return { stage: error.stage, reasonCode: error.reasonCode }
}
export const templateStageOf = (error: unknown) => templateDiagnosticOf(error)?.stage
export function templateCapture<A>(stage: TemplateStage, action: () => A): A {
  try { return action() } catch (error) {
    if (error instanceof TemplateStageError) throw error
    throw new TemplateStageError(stage, error)
  }
}
export async function templateStage<A>(stage: TemplateStage, action: () => Promise<A>): Promise<A> {
  try { return await action() } catch (error) {
    if (error instanceof TemplateStageError) throw error
    throw new TemplateStageError(stage, error)
  }
}

/** Stable public reasons. Never serialize filesystem paths, URLs, submitted values or raw exceptions. */
export const templateErrorMessages = {
  TEMPLATE_PERMISSION: "Template storage is not writable. Check application data folder permissions.",
  TEMPLATE_MISSING: "A required template or project file is missing. Refresh and review again.",
  TEMPLATE_CHANGED: "Project or template changed after preview. Review it again.",
  TEMPLATE_VERSION: "Template version is not compatible with this Orchestra build.",
  TEMPLATE_LINKS: "Saved browser links are not portable. Review links before saving.",
  TEMPLATE_MAIN_UNSET: "The project main session has not been initialized. Open the project once, then save again.",
  TEMPLATE_MAIN_MISSING: "The saved main session no longer exists. Reopen the project to restore its main session.",
  TEMPLATE_MAIN_CHILD: "The project main-session marker points to a child task. The owner record needs repair; no template was saved.",
  TEMPLATE_MAIN_FOREIGN: "The project main session is owned by another project. The owner record needs repair; no template was saved.",
  TEMPLATE_SESSION_CONFLICT: "A top-level project session has conflicting ownership. No sessions or owner markers were changed.",
  TEMPLATE_BROWSER_CHAT_MISSING: "A browser points to a deleted chat. Open the project's Browsers list and review its chat binding. No template was saved.",
  TEMPLATE_BROWSER_CHAT_CHILD: "A browser points to a child task, not a project chat. Review its chat binding. No template was saved.",
  TEMPLATE_BROWSER_CHAT_FOREIGN: "A browser points to a chat owned by another project. Review its chat binding. No foreign chat was exported.",
  TEMPLATE_BROWSER_CHAT_UNLISTED: "A browser chat is outside the project's saved roster. Review its project binding. No template was saved.",
  TEMPLATE_BROWSER_OWNER: "A selected browser has an invalid project or session identity. Review the project's Browsers list.",
  TEMPLATE_OWNERSHIP: "Project ownership or session metadata is incomplete. Reopen the project and review again.",
  TEMPLATE_UNSAFE: "Template content is not portable or contains secret-like data. Review configuration before saving.",
  TEMPLATE_FAILED: "Could not finish the template operation. Review changes and retry the same operation.",
} as const
export type TemplateErrorCode = keyof typeof templateErrorMessages
const exact = new Map<string, TemplateErrorCode>([
  ["Browser chat no longer exists.", "TEMPLATE_BROWSER_CHAT_MISSING"],
  ["Browser chat is a child task.", "TEMPLATE_BROWSER_CHAT_CHILD"],
  ["Browser chat belongs to another project.", "TEMPLATE_BROWSER_CHAT_FOREIGN"],
  ["Browser chat is not in the project roster.", "TEMPLATE_BROWSER_CHAT_UNLISTED"],
  ["Project main session is not initialized.", "TEMPLATE_MAIN_UNSET"],
  ["Project main session is missing.", "TEMPLATE_MAIN_MISSING"],
  ["Project main session points to a child task.", "TEMPLATE_MAIN_CHILD"],
  ["Project main session belongs to another project.", "TEMPLATE_MAIN_FOREIGN"],
  ["A top-level session has conflicting project ownership.", "TEMPLATE_SESSION_CONFLICT"],
  ["Project changed after confirmation preview. Review it again.", "TEMPLATE_CHANGED"],
  ["Project changed during capture.", "TEMPLATE_CHANGED"],
  ["Template changed after preview.", "TEMPLATE_CHANGED"],
  ["Template changed after review.", "TEMPLATE_CHANGED"],
  ["A stable Orchestra version is required for compatibility review.", "TEMPLATE_VERSION"],
  ["Template requires a newer Orchestra version. Nothing was imported.", "TEMPLATE_VERSION"],
  ["Saved links contain nonportable parameters. Review before saving.", "TEMPLATE_LINKS"],
  ["Project metadata is incomplete.", "TEMPLATE_OWNERSHIP"],
  ["Owned session metadata is incomplete.", "TEMPLATE_OWNERSHIP"],
  ["Browser ownership or identity is invalid.", "TEMPLATE_BROWSER_OWNER"],
  ["Project owner differs.", "TEMPLATE_OWNERSHIP"],
  ["Secret-like value detected. No template was prepared.", "TEMPLATE_UNSAFE"],
  ["Absolute paths are not portable. No template was prepared.", "TEMPLATE_UNSAFE"],
  ["Saved URLs require HTTP(S) with no credentials, query or fragment.", "TEMPLATE_LINKS"],
])
export function templateError(error: unknown): { kind: TemplateErrorCode; message: string } {
  if (error instanceof TemplateStageError) return templateError(error.original)
  let kind: TemplateErrorCode = "TEMPLATE_FAILED"
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") kind = "TEMPLATE_PERMISSION"
    else if (code === "ENOENT") kind = "TEMPLATE_MISSING"
    else kind = exact.get(error.message) ?? kind
  }
  return { kind, message: templateErrorMessages[kind] }
}
/** Only declared template errors get a localized reason. No external message is rendered. */
export function templateErrorKey(error: unknown): string | undefined {
  if (!(error instanceof Error) || (error as Error & { _tag?: string })._tag !== "InvalidRequestError") return
  const kind = (error as Error & { kind?: unknown }).kind
  if (typeof kind !== "string" || !Object.hasOwn(templateErrorMessages, kind)) return
  return templateErrorMessages[kind as TemplateErrorCode]
}
