#!/usr/bin/env bun
/**
 * Guardrail script: Check for forbidden legacy OpenCode references and leaks.
 *
 * Verifies that packages/* /src, .github, and script do not introduce unapproved
 * references to upstream opencode.ai endpoints, repositories, or legacy protocol headers.
 *
 * Any legitimate backwards-compatibility reference (e.g. database migration,
 * legacy header fallback, Zen proxy integration) must be explicitly listed in
 * the structured ALLOWLIST below with a clear architectural reason.
 */

import fs from "fs"
import path from "path"

export const FORBIDDEN_PATTERNS = [
  "opencode.ai",
  "models.opencode.ai",
  "anomalyco/opencode",
  "x-opencode-",
  "opencode-zen",
  "Provider.ID.opencode",
] as const

export type ForbiddenPattern = (typeof FORBIDDEN_PATTERNS)[number]

export interface DecouplingAllowlistEntry {
  /** File path relative to repo root (posix slashes) or RegExp matching relative path */
  readonly path: string | RegExp
  /** Array of permitted patterns or "*" for all permitted legacy patterns in this scope */
  readonly allowed: readonly ForbiddenPattern[] | "*"
  /** Architectural / technical justification */
  readonly reason: string
}

/**
 * Structured allowlist of permitted legacy and integration exceptions.
 */
export const ALLOWLIST: readonly DecouplingAllowlistEntry[] = [
  // --------------------------------------------------------------------------
  // Core AI & Provider Integrations (OpenCode Zen & Protocol Adapters)
  // --------------------------------------------------------------------------
  {
    path: "packages/ai/src/protocols/openai-chat.ts",
    allowed: ["opencode.ai"],
    reason: "Legacy OpenCode Zen gateway protocol detection (opencode.ai upstream)",
  },
  {
    path: "packages/ai/src/providers/index.ts",
    allowed: ["opencode-zen"],
    reason: "Export of OpenCode Zen provider for free model support",
  },
  {
    path: "packages/ai/src/providers/opencode-zen.ts",
    allowed: ["opencode.ai", "opencode-zen"],
    reason: "Upstream OpenCode Zen endpoint and provider export for free models",
  },
  {
    path: "packages/cli/src/config/schema.ts",
    allowed: ["opencode.ai"],
    reason: "Legacy CLI config schema URL fallback",
  },
  {
    path: "packages/cli/src/gateway.ts",
    allowed: ["opencode.ai"],
    reason: "OpenCode Zen free-tier gateway endpoint",
  },
  {
    path: "packages/core/src/mcp/oauth.ts",
    allowed: ["opencode.ai"],
    reason: "Legacy OAuth client metadata URL and client URI",
  },
  {
    path: "packages/core/src/models-dev/snapshot.txt",
    allowed: ["opencode.ai"],
    reason: "Snapshot of models.dev catalogue data containing provider URLs",
  },
  {
    path: "packages/core/src/plugin/agent.ts",
    allowed: ["opencode.ai"],
    reason: "Comment explaining upstream opencode.ai free tier gateway restrictions",
  },
  {
    path: "packages/core/src/plugin/provider/opencode.ts",
    allowed: ["opencode.ai", "Provider.ID.opencode"],
    reason: "External OpenCode Zen provider implementation and upstream console URL",
  },
  {
    path: "packages/core/src/plugin/skill/opencode.md",
    allowed: ["opencode.ai"],
    reason: "Built-in skill documentation referencing upstream OpenCode documentation",
  },
  {
    path: "packages/core/src/persistent-pty/pty-binding.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Reference to upstream opencode-pty package origin",
  },
  {
    path: "packages/core/src/mcp/client.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Reference to upstream issue for legacy MCP server compatibility",
  },

  // --------------------------------------------------------------------------
  // Legacy Session, Ticket and Directory Headers (x-opencode-*)
  // --------------------------------------------------------------------------
  {
    path: "packages/cli/src/run/noninteractive.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-directory header compatibility",
  },
  {
    path: "packages/client/src/effect/api/api.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header contract compatibility",
  },
  {
    path: "packages/client/src/effect/generated/client.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header generated client compatibility",
  },
  {
    path: "packages/client/src/promise/generated/client.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header generated client compatibility",
  },
  {
    path: "packages/client/src/promise/generated/types.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header generated types compatibility",
  },
  {
    path: "packages/client/src/solid/data.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-directory header compatibility",
  },
  {
    path: "packages/core/src/generate.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy session headers (x-opencode-session, x-opencode-client) for upstream gateway",
  },
  {
    path: "packages/core/src/session/affinity.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-session header affinity for free-tier gateway",
  },
  {
    path: "packages/core/src/session/model-request.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy gateway headers (x-opencode-session-id, x-opencode-project, x-opencode-client) required by free gateway",
  },
  {
    path: "packages/protocol/src/groups/note.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header for backwards compatibility",
  },
  {
    path: "packages/protocol/src/groups/pty.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-ticket header for backwards compatibility",
  },
  {
    path: "packages/server/src/location.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-directory header compatibility on server",
  },
  {
    path: "packages/tui/src/mini/runtime.ts",
    allowed: ["x-opencode-"],
    reason: "Legacy x-opencode-directory header compatibility in TUI mini runtime",
  },

  // --------------------------------------------------------------------------
  // TUI & UI Feature Plugins & Contexts
  // --------------------------------------------------------------------------
  {
    path: "packages/tui/src/context/notes.tsx",
    allowed: ["opencode.ai"],
    reason: "Legacy default web server fallback in TUI notes",
  },
  {
    path: "packages/tui/src/feature-plugins/system/proxy-manager-core.ts",
    allowed: ["opencode.ai"],
    reason: "OpenCode Zen proxy manager upstream target",
  },
  {
    path: "packages/tui/src/feature-plugins/system/stats.tsx",
    allowed: ["opencode.ai"],
    reason: "Zen models quota and documentation URL",
  },
  {
    path: "packages/tui/src/feature-plugins/system/storybook/merman-layouts.tsx",
    allowed: ["opencode.ai"],
    reason: "Storybook layout fixture with upstream links",
  },
  {
    path: "packages/ui/src/data-display/project-avatar/project-avatar.tsx",
    allowed: ["opencode.ai"],
    reason: "Avatar fallback image URL",
  },
  {
    path: "packages/ui/src/theme/desktop-theme.schema.json",
    allowed: ["opencode.ai"],
    reason: "Desktop theme schema ID URL",
  },

  // --------------------------------------------------------------------------
  // Theme Assets (JSON Schemas & Palettes)
  // --------------------------------------------------------------------------
  {
    path: /^packages\/tui\/src\/theme\/assets\//,
    allowed: ["opencode.ai"],
    reason: "Upstream theme schema URLs and theme author references",
  },
  {
    path: /^packages\/ui\/src\/theme\/themes\//,
    allowed: ["opencode.ai"],
    reason: "Upstream desktop theme schema and theme palette references",
  },

  // --------------------------------------------------------------------------
  // App UI & Settings
  // --------------------------------------------------------------------------
  {
    path: /^packages\/app\/src\/runtime\/i18n\//,
    allowed: ["opencode.ai"],
    reason: "Legacy upstream website URLs in internationalized UI strings",
  },
  {
    path: "packages/app/src/runtime/platform/web.ts",
    allowed: ["opencode.ai"],
    reason: "Web platform documentation link",
  },
  {
    path: "packages/app/src/settings/about/about.tsx",
    allowed: ["opencode.ai", "anomalyco/opencode"],
    reason: "About dialog upstream links and contributors graph link",
  },
  {
    path: "packages/app/src/settings/about/contributors.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Contributors fetcher URL pointing to upstream GitHub repository",
  },
  {
    path: "packages/app/src/settings/appearance/appearance.tsx",
    allowed: ["opencode.ai"],
    reason: "Themes documentation link",
  },
  {
    path: "packages/app/src/settings/providers/extensions.tsx",
    allowed: ["opencode.ai"],
    reason: "Skills documentation link",
  },
  {
    path: "packages/app/src/settings/workspaces/project-extensions.tsx",
    allowed: ["opencode.ai"],
    reason: "Skills documentation link",
  },
  {
    path: "packages/app/src/shell/commands/desktop-menu.ts",
    allowed: ["opencode.ai", "anomalyco/opencode"],
    reason: "Desktop menu documentation and bug report links",
  },
  {
    path: "packages/app/src/providers/connect/dialog.tsx",
    allowed: ["opencode.ai"],
    reason: "Provider connect dialog documentation link",
  },
  {
    path: "packages/app/src/providers/credentials/dialog.tsx",
    allowed: ["opencode.ai"],
    reason: "Credentials dialog documentation link",
  },
  {
    path: "packages/enterprise/src/routes/share/[shareID].tsx",
    allowed: ["opencode.ai", "anomalyco/opencode"],
    reason: "Legacy enterprise share page footer and GitHub links",
  },
  {
    path: "packages/posts/src/layouts/Layout.astro",
    allowed: ["opencode.ai"],
    reason: "Posts layout logo link",
  },
  {
    path: "packages/web/src/components/Lander.astro",
    allowed: ["opencode.ai", "anomalyco/opencode"],
    reason: "Web lander component upstream links",
  },
  {
    path: /^packages\/web\/src\/content\/docs\//,
    allowed: "*",
    reason: "Upstream OpenCode documentation pages and multi-language translations",
  },

  // --------------------------------------------------------------------------
  // Tests & Fixtures
  // --------------------------------------------------------------------------
  {
    path: "packages/gui-extensions/src/ssh/bootstrap.test.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Regression test asserting absence of upstream anomalyco/opencode references",
  },
  {
    path: "packages/gui-extensions/src/wsl/runtime.test.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Regression test asserting absence of upstream anomalyco/opencode references",
  },
  {
    path: "packages/desktop/src/main/files/external-url.test.ts",
    allowed: ["opencode.ai"],
    reason: "Test fixture for external URL resolution",
  },
  {
    path: "packages/desktop/src/renderer/platform/files.test.ts",
    allowed: ["opencode.ai"],
    reason: "Test fixture for external URL browser opening",
  },
  {
    path: "packages/session-ui/src/components/markdown.stories.tsx",
    allowed: ["anomalyco/opencode"],
    reason: "Storybook sample text containing GitHub link",
  },
  {
    path: "packages/session-ui/src/components/markdown-inline-code-kind.test.ts",
    allowed: ["opencode.ai"],
    reason: "Test fixture for markdown parsing",
  },
  {
    path: "packages/session-ui/src/timeline/error-spacing.stories.tsx",
    allowed: ["opencode.ai"],
    reason: "Storybook sample text containing error link",
  },
  {
    path: "packages/simulation/src/backend/index.ts",
    allowed: ["opencode.ai", "models.opencode.ai"],
    reason: "Simulation test server default URLs",
  },
  {
    path: "packages/ui/src/context/marked-parser.test.ts",
    allowed: ["opencode.ai"],
    reason: "Test fixture for markdown URL parsing",
  },
  {
    path: "packages/merman/src/test/layout-audit/fixtures.ts",
    allowed: ["opencode.ai"],
    reason: "Layout audit test fixture data",
  },

  // --------------------------------------------------------------------------
  // Upstream GitHub Workflows (.github) & Automation Scripts (script/)
  // --------------------------------------------------------------------------
  {
    path: /^\.github\/workflows\//,
    allowed: ["anomalyco/opencode", "opencode.ai"],
    reason: "Legacy CI/CD workflow references, bot emails and action triggers from upstream",
  },
  {
    path: "script/github/close-issues.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Upstream GitHub issue triage maintenance script",
  },
  {
    path: "script/github/close-prs.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Upstream GitHub pull request maintenance script",
  },
  {
    path: "script/raw-changelog.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Upstream changelog generator default repository",
  },
  {
    path: "script/stats.ts",
    allowed: ["anomalyco/opencode"],
    reason: "Upstream release statistics scraper",
  },
  {
    path: "script/update-artifact.ts",
    allowed: ["opencode.ai"],
    reason: "Upstream release artifact publisher and update service URL",
  },
]

export interface Violation {
  readonly file: string
  readonly line: number
  readonly pattern: ForbiddenPattern
  readonly snippet: string
  readonly reason: string
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/")
}

function findAllowlistEntry(file: string): DecouplingAllowlistEntry | undefined {
  const norm = normalizePath(file)
  return ALLOWLIST.find((entry) => {
    if (typeof entry.path === "string") {
      return norm === entry.path
    }
    return entry.path.test(norm)
  })
}

function isPatternAllowed(entry: DecouplingAllowlistEntry | undefined, pattern: ForbiddenPattern): boolean {
  if (!entry) return false
  if (entry.allowed === "*") return true
  return entry.allowed.includes(pattern)
}

function getFilesRecursively(dir: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue
      }
      results.push(...getFilesRecursively(full))
    } else if (entry.isFile()) {
      results.push(full)
    }
  }
  return results
}

export function collectScanFiles(rootDir: string = process.cwd()): string[] {
  const scanTargets: string[] = []

  // 1. packages/*/src
  const packagesRoot = path.join(rootDir, "packages")
  if (fs.existsSync(packagesRoot)) {
    const packageDirs = fs.readdirSync(packagesRoot, { withFileTypes: true })
    for (const d of packageDirs) {
      if (d.isDirectory()) {
        const srcDir = path.join(packagesRoot, d.name, "src")
        if (fs.existsSync(srcDir)) {
          scanTargets.push(...getFilesRecursively(srcDir))
        }
      }
    }
  }

  // 2. .github
  const githubDir = path.join(rootDir, ".github")
  if (fs.existsSync(githubDir)) {
    scanTargets.push(...getFilesRecursively(githubDir))
  }

  // 3. script
  const scriptDir = path.join(rootDir, "script")
  if (fs.existsSync(scriptDir)) {
    scanTargets.push(...getFilesRecursively(scriptDir))
  }

  const currentScript = normalizePath(path.join("script", "check-decoupling.ts"))
  return scanTargets
    .map((f) => normalizePath(path.relative(rootDir, f)))
    .filter((f) => f !== currentScript)
}

export function checkDecoupling(rootDir: string = process.cwd()): {
  scannedFiles: number
  violations: Violation[]
} {
  const files = collectScanFiles(rootDir)
  const violations: Violation[] = []

  for (const relFile of files) {
    const fullPath = path.join(rootDir, relFile)
    const content = fs.readFileSync(fullPath, "utf8")
    const lines = content.split("\n")
    const allowlistEntry = findAllowlistEntry(relFile)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (line.includes(pattern)) {
          if (!isPatternAllowed(allowlistEntry, pattern)) {
            violations.push({
              file: relFile,
              line: i + 1,
              pattern,
              snippet: line.trim(),
              reason: allowlistEntry
                ? `File allows [${Array.isArray(allowlistEntry.allowed) ? allowlistEntry.allowed.join(", ") : allowlistEntry.allowed}], but '${pattern}' is not permitted`
                : "File is not in the decoupling allowlist",
            })
          }
        }
      }
    }
  }

  return {
    scannedFiles: files.length,
    violations,
  }
}

// --------------------------------------------------------------------------
// Main CLI Execution
// --------------------------------------------------------------------------
if (import.meta.main) {
  const { scannedFiles, violations } = checkDecoupling()

  if (violations.length > 0) {
    console.error(`\n[DECOUPLING FAILURE] Found ${violations.length} forbidden reference(s):\n`)
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}`)
      console.error(`    Pattern: "${v.pattern}"`)
      console.error(`    Reason:  ${v.reason}`)
      console.error(`    Code:    ${v.snippet}\n`)
    }
    console.error(
      `To fix: Remove the forbidden reference or, if legitimate (e.g. legacy fallback/migration), add a structured entry with reason to ALLOWLIST in script/check-decoupling.ts.\n`,
    )
    process.exit(1)
  }

  console.log(
    `[check:decoupling] PASS: Scanned ${scannedFiles} files across packages/*/src, .github, and script. No decoupling leaks detected.`,
  )
  process.exit(0)
}
