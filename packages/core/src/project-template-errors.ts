/** Stable public reasons. Never serialize filesystem paths, URLs, submitted values or raw exceptions. */
export const templateErrorMessages = {
  TEMPLATE_PERMISSION: "Template storage is not writable. Check application data folder permissions.",
  TEMPLATE_MISSING: "A required template or project file is missing. Refresh and review again.",
  TEMPLATE_CHANGED: "Project or template changed after preview. Review it again.",
  TEMPLATE_VERSION: "Template version is not compatible with this Orchestra build.",
  TEMPLATE_LINKS: "Saved browser links are not portable. Review links before saving.",
  TEMPLATE_OWNERSHIP: "Project ownership or session metadata is incomplete. Reopen the project and review again.",
  TEMPLATE_UNSAFE: "Template content is not portable or contains secret-like data. Review configuration before saving.",
  TEMPLATE_FAILED: "Could not finish the template operation. Review changes and retry the same operation.",
} as const
export type TemplateErrorCode = keyof typeof templateErrorMessages
const exact = new Map<string, TemplateErrorCode>([
  ["Project changed after confirmation preview. Review it again.", "TEMPLATE_CHANGED"],
  ["Project changed during capture.", "TEMPLATE_CHANGED"],
  ["Template changed after preview.", "TEMPLATE_CHANGED"],
  ["Template changed after review.", "TEMPLATE_CHANGED"],
  ["A stable Orchestra version is required for compatibility review.", "TEMPLATE_VERSION"],
  ["Template requires a newer Orchestra version. Nothing was imported.", "TEMPLATE_VERSION"],
  ["Saved links contain nonportable parameters. Review before saving.", "TEMPLATE_LINKS"],
  ["Project metadata is incomplete.", "TEMPLATE_OWNERSHIP"],
  ["Owned session metadata is incomplete.", "TEMPLATE_OWNERSHIP"],
  ["Browser ownership or identity is invalid.", "TEMPLATE_OWNERSHIP"],
  ["Project owner differs.", "TEMPLATE_OWNERSHIP"],
  ["Secret-like value detected. No template was prepared.", "TEMPLATE_UNSAFE"],
  ["Absolute paths are not portable. No template was prepared.", "TEMPLATE_UNSAFE"],
  ["Saved URLs require HTTP(S) with no credentials, query or fragment.", "TEMPLATE_LINKS"],
])
export function templateError(error: unknown): { kind: TemplateErrorCode; message: string } {
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
