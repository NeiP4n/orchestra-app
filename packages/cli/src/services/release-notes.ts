// CHANGELOG sections generated from conventional commits between two releases.
// Merge commits are not user-facing changes and are skipped.
export interface ChangelogCommit {
  readonly hash: string
  readonly subject: string
}

const conventional = /^(\w+)(\(([^)]+)\))?(!)?:\s+(.+)$/

export function changelogSection(
  version: string,
  date: string,
  commits: readonly ChangelogCommit[],
  notes?: string,
): string {
  const sections = [
    { name: "Breaking", items: [] as string[] },
    { name: "Added", items: [] as string[] },
    { name: "Fixed", items: [] as string[] },
    { name: "Docs", items: [] as string[] },
    { name: "Other", items: [] as string[] },
  ]
  const push = (name: string, item: string) => {
    sections.find((section) => section.name === name)?.items.push(item)
  }
  for (const commit of commits) {
    if (commit.subject.startsWith("Merge ")) continue
    const match = commit.subject.match(conventional)
    if (!match) {
      push("Other", commit.subject)
      continue
    }
    const type = match[1]
    const scope = match[3]
    const breaking = match[4]
    const description = match[5]
    const text = scope ? `${description} (${scope})` : description
    if (breaking || /BREAKING CHANGE/.test(commit.subject)) push("Breaking", text)
    else if (type === "feat") push("Added", text)
    else if (type === "fix") push("Fixed", text)
    else if (type === "docs") push("Docs", text)
    else push("Other", text)
  }
  const lines = [`## [${version}] - ${date}`, ""]
  if (notes?.trim()) lines.push(notes.trim(), "")
  let any = false
  for (const section of sections) {
    if (section.items.length === 0) continue
    any = true
    lines.push(`### ${section.name}`, "", ...section.items.map((item) => `- ${item}`), "")
  }
  if (!any) lines.push("No user-facing changes recorded.", "")
  return lines.join("\n")
}

/** Insert a section before the first existing `## [...]` entry, or append it. */
export function prependChangelogSection(text: string, section: string): string {
  const at = text.indexOf("\n## [")
  if (at === -1) return `${text.replace(/\s+$/, "")}\n\n${section}`
  return `${text.slice(0, at + 1)}${section}\n${text.slice(at + 1)}`
}
