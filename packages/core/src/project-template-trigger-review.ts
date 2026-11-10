export * as ProjectTemplateTriggerReview from "./project-template-trigger-review.js"
import { ProjectTemplate } from "./project-template.js"
import type { ProjectTemplateLinkReview } from "./project-template-link-review.js"
export interface Item {
  schedule: number
  browser?: number
  reason: "browser-rebind" | "browser-links-omitted" | "time-review" | "unsupported-event"
}
/** Structural dependencies only. Never infer an account or chat from instruction text, page state,
 * URL, title or secret. A browser binding always needs login/page review even if all URLs survived. */
export function review(
  bundle: ProjectTemplate.Bundle,
  omitted: readonly ProjectTemplateLinkReview.Issue[] = [],
): Item[] {
  return bundle.schedules.map((row, index) => {
    const browserSlot = "browser" in row.source ? row.source.browser : undefined
    const browser = browserSlot ? bundle.browsers.findIndex((b) => b.slot === browserSlot) + 1 : 0
    return {
      schedule: index + 1,
      ...(browser ? { browser } : {}),
      reason: browser
        ? omitted.some((issue) => issue.browser === browser)
          ? "browser-links-omitted"
          : "browser-rebind"
        : row.source.kind.startsWith("execution.")
          ? "unsupported-event"
          : "time-review",
    }
  })
}
export function fromText(text: string) {
  const parsed = ProjectTemplate.parse(text)
  if (!parsed.ok) throw Error("Invalid template trigger review.")
  return review(parsed.value)
}
