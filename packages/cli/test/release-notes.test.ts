import { expect, test } from "bun:test"
import { changelogSection, prependChangelogSection } from "../src/services/release-notes"

const commit = (subject: string) => ({ hash: "abc1234", subject })

test("conventional commits group into Added, Fixed, Docs and Other", () => {
  const section = changelogSection("1.1.0", "2026-11-07", [
    commit("feat(cli): faster startup"),
    commit("fix(server): close the socket on error"),
    commit("docs: update the install guide"),
    commit("chore: bump bun"),
    commit("weird subject without a type"),
  ])
  expect(section).toBe(`## [1.1.0] - 2026-11-07

### Added

- faster startup (cli)

### Fixed

- close the socket on error (server)

### Docs

- update the install guide

### Other

- bump bun
- weird subject without a type
`)
})

test("breaking changes lead the section, with or without a scope", () => {
  const section = changelogSection("2.0.0", "2026-11-07", [
    commit("feat!: drop node 20"),
    commit("fix(core): BREAKING CHANGE: rename the session id"),
    commit("fix: a plain fix"),
  ])
  expect(section).toContain("### Breaking\n\n- drop node 20\n- BREAKING CHANGE: rename the session id (core)\n")
  expect(section.indexOf("### Breaking")).toBeLessThan(section.indexOf("### Fixed"))
})

test("merge commits are not user-facing changes", () => {
  const section = changelogSection("1.1.0", "2026-11-07", [
    commit("Merge branch 'feature-x' into main"),
    commit("fix: one real fix"),
  ])
  expect(section).not.toContain("Merge branch")
  expect(section).toContain("- one real fix")
})

test("an empty range says so instead of printing an empty section", () => {
  expect(changelogSection("1.1.0", "2026-11-07", [])).toBe(`## [1.1.0] - 2026-11-07

No user-facing changes recorded.
`)
})

test("a section inserts before the first existing entry", () => {
  const text = "# Changelog\n\nIntro.\n\n## [1.0.0] - 2026-11-06\n\n- old\n"
  expect(prependChangelogSection(text, "## [1.1.0] - 2026-11-07\n\n- new\n")).toBe(
    "# Changelog\n\nIntro.\n\n## [1.1.0] - 2026-11-07\n\n- new\n\n## [1.0.0] - 2026-11-06\n\n- old\n",
  )
  expect(prependChangelogSection("# Changelog\n", "## [1.0.0] - 2026-11-06\n\n- first\n")).toBe(
    "# Changelog\n\n## [1.0.0] - 2026-11-06\n\n- first\n",
  )
})

test("release notes go under the heading as an intro", () => {
  const section = changelogSection("1.1.0", "2026-11-07", [commit("fix: one fix")], "First release on the new pipeline.")
  expect(section.startsWith("## [1.1.0] - 2026-11-07\n\nFirst release on the new pipeline.\n\n### Fixed\n")).toBe(true)
})
