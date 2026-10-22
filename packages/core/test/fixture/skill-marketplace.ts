import { Schema } from "effect"
import { SkillMarketplace } from "@orchestra/schema/skill-marketplace"

// Generated from the retired proxy's cache.db on 2026-10-15 — do not hand-edit.
//
// Every body here is one the catalog really sent: the listings are whole `search:*` cache rows,
// and the refusal is the DAILY_QUOTA_EXCEEDED body captured from a live call the same day.

/** A real listing, verbatim. */
export const LISTING_A = "{\"success\": true, \"data\": {\"skills\": [{\"id\": \"openclaw-openclaw-agents-skills-openclaw-secret-scanning-maintainer-skill-md\", \"name\": \"openclaw-secret-scanning-maintainer\", \"author\": \"openclaw\", \"description\": \"Triage, redact, clean up, and resolve OpenClaw GitHub Secret Scanning alerts in issues or PRs.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-secret-scanning-maintainer\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-secret-scanning-maintainer\", \"stars\": 389030, \"updatedAt\": 1784690923}, {\"id\": \"affaan-m-ecc-kiro-skills-react-patterns-skill-md\", \"name\": \"react-patterns\", \"author\": \"affaan-m\", \"description\": \"React 18/19 patterns including hooks discipline, server/client component boundaries, Suspense + error boundaries, form actions, data fetching, state management decision trees, and accessibility-first composition. Use when writing or reviewing React components.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/affaan-m/ECC/tree/main/.kiro/skills/react-patterns\", \"skillUrl\": \"https://skillsmp.com/creators/affaan-m/ecc/kiro-skills-react-patterns\", \"stars\": 260918, \"updatedAt\": 1780809997}, {\"id\": \"affaan-m-ecc-skills-react-patterns-skill-md\", \"name\": \"react-patterns\", \"author\": \"affaan-m\", \"description\": \"React 18/19 patterns including hooks discipline, server/client component boundaries, Suspense + error boundaries, form actions, data fetching, state management decision trees, and accessibility-first composition. Use when writing or reviewing React components.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/affaan-m/ECC/tree/main/skills/react-patterns\", \"skillUrl\": \"https://skillsmp.com/creators/affaan-m/ecc/skills-react-patterns\", \"stars\": 260918, \"updatedAt\": 1781179941}], \"pagination\": {\"page\": 1, \"limit\": 3, \"total\": 4, \"totalPages\": 2, \"hasNext\": true, \"hasPrev\": false, \"totalIsExact\": false}, \"filters\": {\"search\": \"react hooks\", \"sortBy\": \"stars\"}}, \"meta\": {\"requestId\": \"7205d2c7-c276-48a5-9527-15c5d6d218bf\", \"responseTimeMs\": 8}}"

/** Another page of the same real query; it repeats rows from the first, so dedup has real work. */
export const LISTING_B = "{\"success\": true, \"data\": {\"skills\": [{\"id\": \"openclaw-openclaw-agents-skills-openclaw-secret-scanning-maintainer-skill-md\", \"name\": \"openclaw-secret-scanning-maintainer\", \"author\": \"openclaw\", \"description\": \"Triage, redact, clean up, and resolve OpenClaw GitHub Secret Scanning alerts in issues or PRs.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-secret-scanning-maintainer\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-secret-scanning-maintainer\", \"stars\": 389030, \"updatedAt\": 1784690923}, {\"id\": \"affaan-m-ecc-kiro-skills-react-patterns-skill-md\", \"name\": \"react-patterns\", \"author\": \"affaan-m\", \"description\": \"React 18/19 patterns including hooks discipline, server/client component boundaries, Suspense + error boundaries, form actions, data fetching, state management decision trees, and accessibility-first composition. Use when writing or reviewing React components.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/affaan-m/ECC/tree/main/.kiro/skills/react-patterns\", \"skillUrl\": \"https://skillsmp.com/creators/affaan-m/ecc/kiro-skills-react-patterns\", \"stars\": 260918, \"updatedAt\": 1780809997}], \"pagination\": {\"page\": 1, \"limit\": 2, \"total\": 3, \"totalPages\": 2, \"hasNext\": true, \"hasPrev\": false, \"totalIsExact\": false}, \"filters\": {\"search\": \"react hooks\", \"sortBy\": \"stars\"}}, \"meta\": {\"requestId\": \"e5d95b08-9782-442d-8ab2-0818b12d1b97\", \"responseTimeMs\": 436}}"

/** A real listing that shares no id with the first. */
export const LISTING_C = "{\"success\": true, \"data\": {\"skills\": [{\"id\": \"mattpocock-skills-skills-in-progress-setup-ts-deep-modules-skill-md\", \"name\": \"setup-ts-deep-modules\", \"author\": \"mattpocock\", \"description\": \"Wire dependency-cruiser into a TypeScript repo so each package is a deep module, with implementation hidden in subfolders and reachable only through its entry-point files. User-invoked.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/mattpocock/skills/tree/main/skills/in-progress/setup-ts-deep-modules\", \"skillUrl\": \"https://skillsmp.com/creators/mattpocock/skills/skills-in-progress-setup-ts-deep-modules\", \"stars\": 264042, \"updatedAt\": 1787133817}, {\"id\": \"mattpocock-skills-skills-misc-migrate-to-shoehorn-skill-md\", \"name\": \"migrate-to-shoehorn\", \"author\": \"mattpocock\", \"description\": \"Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial test data.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/mattpocock/skills/tree/main/skills/misc/migrate-to-shoehorn\", \"skillUrl\": \"https://skillsmp.com/creators/mattpocock/skills/skills-misc-migrate-to-shoehorn\", \"stars\": 264042, \"updatedAt\": 1783943838}, {\"id\": \"affaan-m-ecc-docs-ja-jp-skills-coding-standards-skill-md\", \"name\": \"coding-standards\", \"author\": \"affaan-m\", \"description\": \"TypeScript、JavaScript、React、Node.js開発のための汎用コーディング標準、ベストプラクティス、パターン。\", \"contentLanguage\": \"ja\", \"githubUrl\": \"https://github.com/affaan-m/ECC/tree/main/docs/ja-JP/skills/coding-standards\", \"skillUrl\": \"https://skillsmp.com/creators/affaan-m/ecc/docs-ja-jp-skills-coding-standards\", \"stars\": 260918, \"updatedAt\": 1774833678}], \"pagination\": {\"page\": 1, \"limit\": 3, \"total\": 4, \"totalPages\": 2, \"hasNext\": true, \"hasPrev\": false, \"totalIsExact\": false}, \"filters\": {\"search\": \"TypeScript testing\", \"sortBy\": \"stars\"}}, \"meta\": {\"requestId\": \"419545d6-a363-40b1-9a76-ccf3c11cf3b2\", \"responseTimeMs\": 459}}"

/** The largest real listing in the cache, for searching over real catalog text. */
export const LISTING_PDF = "{\"success\": true, \"data\": {\"skills\": [{\"id\": \"openclaw-openclaw-agents-skills-agent-transcript-skill-md\", \"name\": \"agent-transcript\", \"author\": \"openclaw\", \"description\": \"Add a redacted agent transcript section to GitHub PR or issue bodies during OpenClaw agent-created PR/issue workflows.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/agent-transcript\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-agent-transcript\", \"stars\": 391533, \"updatedAt\": 1779808673}, {\"id\": \"openclaw-openclaw-custodian-skills-add-model-provider-skill-md\", \"name\": \"add-model-provider\", \"author\": \"openclaw\", \"description\": \"Add and live-prove a model provider with non-interactive config one-liners, without exposing credentials.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/custodian-skills/add-model-provider\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/custodian-skills-add-model-provider\", \"stars\": 391533, \"updatedAt\": 1787124782}, {\"id\": \"openclaw-openclaw-agents-skills-auto-qa-skill-md\", \"name\": \"auto-qa\", \"author\": \"openclaw\", \"description\": \"Continuously audit, live-test, and stress-test the current OpenClaw codebase across at least ten independently scoped subsystem lanes; default to 100 independently verified, landed root-cause fixes, maintain an evidence-backed report, and announce each merged pull request immediately. Use for OpenClaw-wide autonomous QA, live-provider campaigns, gateway, CLI, web, plugin, native-app, scenario, packaging, and extended soak testing.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/auto-qa\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-auto-qa\", \"stars\": 391533, \"updatedAt\": 1786893904}, {\"id\": \"openclaw-openclaw-agents-skills-autoreview-skill-md\", \"name\": \"autoreview\", \"author\": \"openclaw\", \"description\": \"Structured Codex, Claude, Amp, Pi, or Kimi code review when explicitly requested.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/autoreview\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-autoreview\", \"stars\": 391533, \"updatedAt\": 1788351039}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-docker-e2e-authoring-skill-md\", \"name\": \"openclaw-docker-e2e-authoring\", \"author\": \"openclaw\", \"description\": \"Author OpenClaw Docker E2E and live provider Docker lanes.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-docker-e2e-authoring\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-docker-e2e-authoring\", \"stars\": 391533, \"updatedAt\": 1779108335}, {\"id\": \"openclaw-openclaw-extensions-acpx-skills-acp-router-skill-md\", \"name\": \"acp-router\", \"author\": \"openclaw\", \"description\": \"Route plain-language requests for Claude Code, Cursor, Copilot, OpenClaw ACP, OpenCode, Gemini CLI, Qwen, Kiro, Kimi, iFlow, Factory Droid, Kilocode, or explicit ACP harness work into either OpenClaw ACP runtime sessions or direct acpx-driven sessions (\\\"telephone game\\\" flow). For coding-agent thread requests, read this skill first, then use only `sessions_spawn` for thread creation. Codex chat binding defaults to the native Codex app-server plugin unless ACP is explicit or background spawn needs ACP.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/acpx/skills/acp-router\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-acpx-skills-acp-router\", \"stars\": 391533, \"updatedAt\": 1787994425}, {\"id\": \"openclaw-openclaw-skills-apple-notes-skill-md\", \"name\": \"apple-notes\", \"author\": \"openclaw\", \"description\": \"Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/apple-notes\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-apple-notes\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-apple-reminders-skill-md\", \"name\": \"apple-reminders\", \"author\": \"openclaw\", \"description\": \"List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/apple-reminders\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-apple-reminders\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-agents-skills-test-audit-skill-md\", \"name\": \"test-audit\", \"author\": \"openclaw\", \"description\": \"Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-test-audit\", \"stars\": 391533, \"updatedAt\": 1786787018}, {\"id\": \"openclaw-openclaw-extensions-browser-skills-browser-automation-skill-md\", \"name\": \"browser-automation\", \"author\": \"openclaw\", \"description\": \"Use when controlling web pages with the OpenClaw browser tool, especially multi-step flows, login checks, tab management, or recovery from stale refs/timeouts.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/browser/skills/browser-automation\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-browser-skills-browser-automation\", \"stars\": 391533, \"updatedAt\": 1787945027}, {\"id\": \"openclaw-openclaw-skills-coding-agent-skill-md\", \"name\": \"coding-agent\", \"author\": \"openclaw\", \"description\": \"Delegate coding work to Codex, Claude Code, or OpenCode as background workers; not simple edits or read-only code lookup.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/coding-agent\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-coding-agent\", \"stars\": 391533, \"updatedAt\": 1785303822}, {\"id\": \"openclaw-openclaw-skills-openai-whisper-api-skill-md\", \"name\": \"openai-whisper-api\", \"author\": \"openclaw\", \"description\": \"OpenAI Audio Transcriptions API via curl; gpt-4o-transcribe, mini, diarize, or whisper-1.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/openai-whisper-api\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-openai-whisper-api\", \"stars\": 391533, \"updatedAt\": 1779489435}, {\"id\": \"openclaw-openclaw-agents-skills-release-openclaw-announcement-skill-md\", \"name\": \"release-openclaw-announcement\", \"author\": \"openclaw\", \"description\": \"Draft or post OpenClaw beta, stable, or extended-stable Discord release announcements from changelog, tag, registry, and validation evidence. Use when announcing a release, release candidate, or asking what users should test after an OpenClaw release.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-announcement\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-announcement\", \"stars\": 391533, \"updatedAt\": 1784771328}, {\"id\": \"openclaw-openclaw-agents-skills-claw-score-skill-md\", \"name\": \"claw-score\", \"author\": \"openclaw\", \"description\": \"Audit or refresh OpenClaw maturity scorecard docs from root taxonomy, maturity scores, and QA evidence artifacts without using maintainer discrawl data or committed inventory reports.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/claw-score\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-claw-score\", \"stars\": 391533, \"updatedAt\": 1787164243}, {\"id\": \"openclaw-openclaw-skills-healthcheck-skill-md\", \"name\": \"healthcheck\", \"author\": \"openclaw\", \"description\": \"Audit/harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, gateway security.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/healthcheck\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-healthcheck\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-skill-creator-skill-md\", \"name\": \"skill-creator\", \"author\": \"openclaw\", \"description\": \"Author or review AgentSkills: create, repair, validate, or restructure SKILL.md files and bundled resources.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/skill-creator\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-skill-creator\", \"stars\": 391533, \"updatedAt\": 1786437360}, {\"id\": \"openclaw-openclaw-skills-things-mac-skill-md\", \"name\": \"things-mac\", \"author\": \"openclaw\", \"description\": \"Add, update, list, search, or inspect Things 3 todos, inbox, today, projects, areas, and tags on macOS.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/things-mac\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-things-mac\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-custodian-skills-configure-channel-skill-md\", \"name\": \"configure-channel\", \"author\": \"openclaw\", \"description\": \"Configure and prove a chat channel with non-interactive one-liners; secrets only as SecretRefs.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/custodian-skills/configure-channel\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/custodian-skills-configure-channel\", \"stars\": 391533, \"updatedAt\": 1787124782}, {\"id\": \"openclaw-openclaw-agents-skills-discord-user-post-skill-md\", \"name\": \"discord-user-post\", \"author\": \"openclaw\", \"description\": \"Post an approved message as the logged-in Discord user through the Discord desktop app. Use for release announcements or other direct user-authored Discord posts; not for OpenClaw channel sends, bots, webhooks, relays, agent sessions, or archive search.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/discord-user-post\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-discord-user-post\", \"stars\": 391533, \"updatedAt\": 1781515590}, {\"id\": \"openclaw-openclaw-agents-skills-discrawl-skill-md\", \"name\": \"discrawl\", \"author\": \"openclaw\", \"description\": \"Discord archive: search, sync freshness, DMs, summaries, TUI, repo/release work.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/discrawl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-discrawl\", \"stars\": 391533, \"updatedAt\": 1780084972}, {\"id\": \"openclaw-openclaw-agents-skills-gitcrawl-skill-md\", \"name\": \"gitcrawl\", \"author\": \"openclaw\", \"description\": \"GitHub archive: issue/PR search, sync freshness, duplicate clusters, gh-shim PR status, and Gitcrawl repo work.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/gitcrawl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-gitcrawl\", \"stars\": 391533, \"updatedAt\": 1779016703}, {\"id\": \"openclaw-openclaw-agents-skills-graincrawl-skill-md\", \"name\": \"graincrawl\", \"author\": \"openclaw\", \"description\": \"Granola archive: search, sync freshness, notes, transcripts, panels, SQL counts, and Graincrawl repo work.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/graincrawl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-graincrawl\", \"stars\": 391533, \"updatedAt\": 1779016703}, {\"id\": \"openclaw-openclaw-agents-skills-notcrawl-skill-md\", \"name\": \"notcrawl\", \"author\": \"openclaw\", \"description\": \"Notion archive: search, sync freshness, pages/databases, Markdown exports, SQL counts, and Notcrawl repo work.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/notcrawl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-notcrawl\", \"stars\": 391533, \"updatedAt\": 1779016703}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-refactor-docs-skill-md\", \"name\": \"openclaw-refactor-docs\", \"author\": \"openclaw\", \"description\": \"Refactor an existing OpenClaw docs page with source-audited preservation, restructuring, and verification.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-refactor-docs\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-refactor-docs\", \"stars\": 391533, \"updatedAt\": 1786021045}, {\"id\": \"openclaw-openclaw-agents-skills-release-openclaw-plugin-testing-skill-md\", \"name\": \"release-openclaw-plugin-testing\", \"author\": \"openclaw\", \"description\": \"Plan and run pre-release OpenClaw plugin validation across bundled plugins, package artifacts, lifecycle commands, doctor/fix, config round-trip, gateway startup, SDK compatibility, Docker E2E, Package Acceptance, and Testbox proof.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-plugin-testing\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-plugin-testing\", \"stars\": 391533, \"updatedAt\": 1786893904}, {\"id\": \"openclaw-openclaw-agents-skills-slacrawl-skill-md\", \"name\": \"slacrawl\", \"author\": \"openclaw\", \"description\": \"Slack archive: search, sync freshness, threads/DMs, SQL counts, and Slacrawl repo work.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/slacrawl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-slacrawl\", \"stars\": 391533, \"updatedAt\": 1779016703}, {\"id\": \"openclaw-openclaw-agents-skills-technical-documentation-skill-md\", \"name\": \"technical-documentation\", \"author\": \"openclaw\", \"description\": \"Build and review high-quality technical docs as well as agent instruction files in your repository.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/technical-documentation\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-technical-documentation\", \"stars\": 391533, \"updatedAt\": 1779690014}, {\"id\": \"openclaw-openclaw-extensions-memory-wiki-skills-obsidian-vault-maintainer-skill-md\", \"name\": \"obsidian-vault-maintainer\", \"author\": \"openclaw\", \"description\": \"Maintain an Obsidian-friendly memory wiki vault with wikilinks, frontmatter, and official Obsidian CLI awareness.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/memory-wiki/skills/obsidian-vault-maintainer\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-memory-wiki-skills-obsidian-vault-maintainer\", \"stars\": 391533, \"updatedAt\": 1775447812}, {\"id\": \"openclaw-openclaw-skills-peekaboo-skill-md\", \"name\": \"peekaboo\", \"author\": \"openclaw\", \"description\": \"Capture and automate macOS UI with the Peekaboo CLI.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/peekaboo\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-peekaboo\", \"stars\": 391533, \"updatedAt\": 1781529256}, {\"id\": \"openclaw-openclaw-skills-session-logs-skill-md\", \"name\": \"session-logs\", \"author\": \"openclaw\", \"description\": \"Search and analyze your own session logs (older/parent conversations) using jq.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/session-logs\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-session-logs\", \"stars\": 391533, \"updatedAt\": 1782896878}, {\"id\": \"openclaw-openclaw-agents-skills-clawsweeper-skill-md\", \"name\": \"clawsweeper\", \"author\": \"openclaw\", \"description\": \"Use for all ClawSweeper work: OpenClaw issue/PR sweep reports, repair jobs, cloud fix PRs, @clawsweeper maintainer mention commands, trusted ClawSweeper-reviewed autofix/automerge, GitHub Actions monitoring, permissions, gates, and manual backfills.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/clawsweeper\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-clawsweeper\", \"stars\": 391533, \"updatedAt\": 1786138748}, {\"id\": \"openclaw-openclaw-agents-skills-deslop-skill-md\", \"name\": \"deslop\", \"author\": \"openclaw\", \"description\": \"Diff-scoped AI-slop cleanup pass: strip comment slop, defensive-check slop, type-laundering, and style drift from the current branch diff before autoreview.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/deslop\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-deslop\", \"stars\": 391533, \"updatedAt\": 1786856628}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-ci-limits-skill-md\", \"name\": \"openclaw-ci-limits\", \"author\": \"openclaw\", \"description\": \"Manage OpenClaw GitHub Actions and Blacksmith CI capacity, runner-registration budgets, fanout caps, main-push single-flight, shard sizing, hosted-runner offload, queue health, and safe ramp-down/ramp-up changes. Use when tuning `.github/workflows/*`, `docs/ci.md`, CI runner labels, matrix `max-parallel`, ClawSweeper/Blacksmith burst protection, CodeQL runner placement, or investigating slow/queued OpenClaw CI.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-ci-limits\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-ci-limits\", \"stars\": 391533, \"updatedAt\": 1788349939}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-pr-maintainer-skill-md\", \"name\": \"openclaw-pr-maintainer\", \"author\": \"openclaw\", \"description\": \"Use immediately for any pasted OpenClaw GitHub issue or PR URL/number, and for OpenClaw issue/PR orchestration, review, triage, root-cause repair, PR rewrite, duplicate search, opener identity/who wrote it, author account age/activity, comments, labels, close, land, or maintainer evidence checks.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-pr-maintainer\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-pr-maintainer\", \"stars\": 391533, \"updatedAt\": 1788204318}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-update-skill-md\", \"name\": \"openclaw-update\", \"author\": \"openclaw\", \"description\": \"Route routine updates of an existing local or remote OpenClaw Gateway to its installation owner, with automatic session recovery. Defer to deployment-specific skills when available.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-update\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-update\", \"stars\": 391533, \"updatedAt\": 1788135564}, {\"id\": \"openclaw-openclaw-agents-skills-release-openclaw-nightly-skill-md\", \"name\": \"release-openclaw-nightly\", \"author\": \"openclaw\", \"description\": \"OpenClaw Tideclaw alpha/nightly release automation: isolated branches, local fixes, release CI, branch retention, and forward-port to main.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-nightly\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-nightly\", \"stars\": 391533, \"updatedAt\": 1786617936}, {\"id\": \"openclaw-openclaw-agents-skills-security-triage-skill-md\", \"name\": \"security-triage\", \"author\": \"openclaw\", \"description\": \"Triage OpenClaw security advisories, drafts, and GHSA reports with shipped-tag and trust-model proof.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/security-triage\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-security-triage\", \"stars\": 391533, \"updatedAt\": 1779982239}, {\"id\": \"openclaw-openclaw-extensions-feishu-skills-feishu-drive-skill-md\", \"name\": \"feishu-drive\", \"author\": \"openclaw\", \"description\": \"Feishu cloud-storage and comment workflows. Activate when the user mentions cloud space, folders, Drive files, or document comments.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/feishu/skills/feishu-drive\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-feishu-skills-feishu-drive\", \"stars\": 391533, \"updatedAt\": 1785803460}, {\"id\": \"openclaw-openclaw-extensions-feishu-skills-feishu-perm-skill-md\", \"name\": \"feishu-perm\", \"author\": \"openclaw\", \"description\": \"Feishu collaborator and permission workflows. Activate when the user explicitly asks to inspect or change sharing, permissions, or collaborators.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/feishu/skills/feishu-perm\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-feishu-skills-feishu-perm\", \"stars\": 391533, \"updatedAt\": 1785803460}, {\"id\": \"openclaw-openclaw-skills-1password-skill-md\", \"name\": \"1password\", \"author\": \"openclaw\", \"description\": \"Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/1password\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-1password\", \"stars\": 391533, \"updatedAt\": 1784791268}, {\"id\": \"openclaw-openclaw-skills-blogwatcher-skill-md\", \"name\": \"blogwatcher\", \"author\": \"openclaw\", \"description\": \"Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/blogwatcher\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-blogwatcher\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-notion-skill-md\", \"name\": \"notion\", \"author\": \"openclaw\", \"description\": \"Notion CLI/API for pages, Markdown content, data sources, files, comments, search, Workers, and raw API calls.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/notion\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-notion\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-openhue-skill-md\", \"name\": \"openhue\", \"author\": \"openclaw\", \"description\": \"Control Philips Hue lights and scenes via the OpenHue CLI.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/openhue\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-openhue\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-songsee-skill-md\", \"name\": \"songsee\", \"author\": \"openclaw\", \"description\": \"Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/songsee\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-songsee\", \"stars\": 391533, \"updatedAt\": 1779015027}, {\"id\": \"openclaw-openclaw-skills-weather-skill-md\", \"name\": \"weather\", \"author\": \"openclaw\", \"description\": \"Current weather and forecasts with web_fetch, falling back to wttr.in curl for locations, rain, temperature, travel planning.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/weather\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-weather\", \"stars\": 391533, \"updatedAt\": 1780684555}, {\"id\": \"openclaw-openclaw-skills-xurl-skill-md\", \"name\": \"xurl\", \"author\": \"openclaw\", \"description\": \"xurl CLI for authenticated X posts, replies, reads/search, DMs, media upload, followers, auth status, or raw v2 API calls.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/xurl\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-xurl\", \"stars\": 391533, \"updatedAt\": 1783523229}, {\"id\": \"openclaw-openclaw-extensions-canvas-skills-canvas-skill-md\", \"name\": \"canvas\", \"author\": \"openclaw\", \"description\": \"Present hosted widget documents on a connected macOS panel and control panel visibility or navigation.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/extensions/canvas/skills/canvas\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/extensions-canvas-skills-canvas\", \"stars\": 391533, \"updatedAt\": 1787152867}, {\"id\": \"openclaw-openclaw-skills-clawhub-skill-md\", \"name\": \"clawhub\", \"author\": \"openclaw\", \"description\": \"Search ClawHub for skills when a requested capability is not already available; install, verify, update, uninstall, publish, or sync skills.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/skills/clawhub\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/skills-clawhub\", \"stars\": 391533, \"updatedAt\": 1785793142}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-release-validation-skill-md\", \"name\": \"openclaw-release-validation\", \"author\": \"openclaw\", \"description\": \"Test the latest OpenClaw main commit through an isolated OCM copy or an explicitly approved in-place gateway update, then guide structured release feedback.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-release-validation\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-release-validation\", \"stars\": 391533, \"updatedAt\": 1788216778}, {\"id\": \"openclaw-openclaw-agents-skills-openclaw-repair-sweep-skill-md\", \"name\": \"openclaw-repair-sweep\", \"author\": \"openclaw\", \"description\": \"Orchestrate worker fleets over OpenClaw issues and PRs: prove root causes, prefer clean refactors over quick patches, land verified repairs, and close items proven fixed or no longer useful.\", \"contentLanguage\": \"en\", \"githubUrl\": \"https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-repair-sweep\", \"skillUrl\": \"https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-repair-sweep\", \"stars\": 391533, \"updatedAt\": 1788113107}], \"pagination\": {\"page\": 1, \"limit\": 50, \"total\": 51, \"totalPages\": 2, \"hasNext\": true, \"hasPrev\": false, \"totalIsExact\": false}, \"filters\": {\"search\": \"a\", \"sortBy\": \"stars\"}}, \"meta\": {\"requestId\": \"48046508-b77d-41a1-bf19-a28292e9d0b3\", \"responseTimeMs\": 315}}"

/** A real refusal: the catalog answered 200 and refused inside the body. */
export const QUOTA_REFUSAL = "{\"success\":false,\"error\":{\"code\":\"DAILY_QUOTA_EXCEEDED\",\"message\":\"Daily API quota of 50 requests exceeded. Resets at midnight UTC. Sign up and use an API key for a higher quota (500/day).\"}}"

/** Every distinct row in the listings above, as the index would hold them. */
export const SKILLS = [
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-secret-scanning-maintainer-skill-md",
    "name": "openclaw-secret-scanning-maintainer",
    "author": "openclaw",
    "description": "Triage, redact, clean up, and resolve OpenClaw GitHub Secret Scanning alerts in issues or PRs.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-secret-scanning-maintainer",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-secret-scanning-maintainer",
    "stars": 389030,
    "updatedAt": 1784690923
  },
  {
    "id": "affaan-m-ecc-kiro-skills-react-patterns-skill-md",
    "name": "react-patterns",
    "author": "affaan-m",
    "description": "React 18/19 patterns including hooks discipline, server/client component boundaries, Suspense + error boundaries, form actions, data fetching, state management decision trees, and accessibility-first composition. Use when writing or reviewing React components.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/affaan-m/ECC/tree/main/.kiro/skills/react-patterns",
    "skillUrl": "https://skillsmp.com/creators/affaan-m/ecc/kiro-skills-react-patterns",
    "stars": 260918,
    "updatedAt": 1780809997
  },
  {
    "id": "affaan-m-ecc-skills-react-patterns-skill-md",
    "name": "react-patterns",
    "author": "affaan-m",
    "description": "React 18/19 patterns including hooks discipline, server/client component boundaries, Suspense + error boundaries, form actions, data fetching, state management decision trees, and accessibility-first composition. Use when writing or reviewing React components.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/affaan-m/ECC/tree/main/skills/react-patterns",
    "skillUrl": "https://skillsmp.com/creators/affaan-m/ecc/skills-react-patterns",
    "stars": 260918,
    "updatedAt": 1781179941
  },
  {
    "id": "mattpocock-skills-skills-in-progress-setup-ts-deep-modules-skill-md",
    "name": "setup-ts-deep-modules",
    "author": "mattpocock",
    "description": "Wire dependency-cruiser into a TypeScript repo so each package is a deep module, with implementation hidden in subfolders and reachable only through its entry-point files. User-invoked.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/mattpocock/skills/tree/main/skills/in-progress/setup-ts-deep-modules",
    "skillUrl": "https://skillsmp.com/creators/mattpocock/skills/skills-in-progress-setup-ts-deep-modules",
    "stars": 264042,
    "updatedAt": 1787133817
  },
  {
    "id": "mattpocock-skills-skills-misc-migrate-to-shoehorn-skill-md",
    "name": "migrate-to-shoehorn",
    "author": "mattpocock",
    "description": "Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial test data.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/mattpocock/skills/tree/main/skills/misc/migrate-to-shoehorn",
    "skillUrl": "https://skillsmp.com/creators/mattpocock/skills/skills-misc-migrate-to-shoehorn",
    "stars": 264042,
    "updatedAt": 1783943838
  },
  {
    "id": "affaan-m-ecc-docs-ja-jp-skills-coding-standards-skill-md",
    "name": "coding-standards",
    "author": "affaan-m",
    "description": "TypeScript、JavaScript、React、Node.js開発のための汎用コーディング標準、ベストプラクティス、パターン。",
    "contentLanguage": "ja",
    "githubUrl": "https://github.com/affaan-m/ECC/tree/main/docs/ja-JP/skills/coding-standards",
    "skillUrl": "https://skillsmp.com/creators/affaan-m/ecc/docs-ja-jp-skills-coding-standards",
    "stars": 260918,
    "updatedAt": 1774833678
  },
  {
    "id": "openclaw-openclaw-agents-skills-agent-transcript-skill-md",
    "name": "agent-transcript",
    "author": "openclaw",
    "description": "Add a redacted agent transcript section to GitHub PR or issue bodies during OpenClaw agent-created PR/issue workflows.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/agent-transcript",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-agent-transcript",
    "stars": 391533,
    "updatedAt": 1779808673
  },
  {
    "id": "openclaw-openclaw-custodian-skills-add-model-provider-skill-md",
    "name": "add-model-provider",
    "author": "openclaw",
    "description": "Add and live-prove a model provider with non-interactive config one-liners, without exposing credentials.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/custodian-skills/add-model-provider",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/custodian-skills-add-model-provider",
    "stars": 391533,
    "updatedAt": 1787124782
  },
  {
    "id": "openclaw-openclaw-agents-skills-auto-qa-skill-md",
    "name": "auto-qa",
    "author": "openclaw",
    "description": "Continuously audit, live-test, and stress-test the current OpenClaw codebase across at least ten independently scoped subsystem lanes; default to 100 independently verified, landed root-cause fixes, maintain an evidence-backed report, and announce each merged pull request immediately. Use for OpenClaw-wide autonomous QA, live-provider campaigns, gateway, CLI, web, plugin, native-app, scenario, packaging, and extended soak testing.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/auto-qa",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-auto-qa",
    "stars": 391533,
    "updatedAt": 1786893904
  },
  {
    "id": "openclaw-openclaw-agents-skills-autoreview-skill-md",
    "name": "autoreview",
    "author": "openclaw",
    "description": "Structured Codex, Claude, Amp, Pi, or Kimi code review when explicitly requested.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/autoreview",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-autoreview",
    "stars": 391533,
    "updatedAt": 1788351039
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-docker-e2e-authoring-skill-md",
    "name": "openclaw-docker-e2e-authoring",
    "author": "openclaw",
    "description": "Author OpenClaw Docker E2E and live provider Docker lanes.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-docker-e2e-authoring",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-docker-e2e-authoring",
    "stars": 391533,
    "updatedAt": 1779108335
  },
  {
    "id": "openclaw-openclaw-extensions-acpx-skills-acp-router-skill-md",
    "name": "acp-router",
    "author": "openclaw",
    "description": "Route plain-language requests for Claude Code, Cursor, Copilot, OpenClaw ACP, OpenCode, Gemini CLI, Qwen, Kiro, Kimi, iFlow, Factory Droid, Kilocode, or explicit ACP harness work into either OpenClaw ACP runtime sessions or direct acpx-driven sessions (\"telephone game\" flow). For coding-agent thread requests, read this skill first, then use only `sessions_spawn` for thread creation. Codex chat binding defaults to the native Codex app-server plugin unless ACP is explicit or background spawn needs ACP.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/acpx/skills/acp-router",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-acpx-skills-acp-router",
    "stars": 391533,
    "updatedAt": 1787994425
  },
  {
    "id": "openclaw-openclaw-skills-apple-notes-skill-md",
    "name": "apple-notes",
    "author": "openclaw",
    "description": "Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/apple-notes",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-apple-notes",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-apple-reminders-skill-md",
    "name": "apple-reminders",
    "author": "openclaw",
    "description": "List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/apple-reminders",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-apple-reminders",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-agents-skills-test-audit-skill-md",
    "name": "test-audit",
    "author": "openclaw",
    "description": "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-test-audit",
    "stars": 391533,
    "updatedAt": 1786787018
  },
  {
    "id": "openclaw-openclaw-extensions-browser-skills-browser-automation-skill-md",
    "name": "browser-automation",
    "author": "openclaw",
    "description": "Use when controlling web pages with the OpenClaw browser tool, especially multi-step flows, login checks, tab management, or recovery from stale refs/timeouts.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/browser/skills/browser-automation",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-browser-skills-browser-automation",
    "stars": 391533,
    "updatedAt": 1787945027
  },
  {
    "id": "openclaw-openclaw-skills-coding-agent-skill-md",
    "name": "coding-agent",
    "author": "openclaw",
    "description": "Delegate coding work to Codex, Claude Code, or OpenCode as background workers; not simple edits or read-only code lookup.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/coding-agent",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-coding-agent",
    "stars": 391533,
    "updatedAt": 1785303822
  },
  {
    "id": "openclaw-openclaw-skills-openai-whisper-api-skill-md",
    "name": "openai-whisper-api",
    "author": "openclaw",
    "description": "OpenAI Audio Transcriptions API via curl; gpt-4o-transcribe, mini, diarize, or whisper-1.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/openai-whisper-api",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-openai-whisper-api",
    "stars": 391533,
    "updatedAt": 1779489435
  },
  {
    "id": "openclaw-openclaw-agents-skills-release-openclaw-announcement-skill-md",
    "name": "release-openclaw-announcement",
    "author": "openclaw",
    "description": "Draft or post OpenClaw beta, stable, or extended-stable Discord release announcements from changelog, tag, registry, and validation evidence. Use when announcing a release, release candidate, or asking what users should test after an OpenClaw release.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-announcement",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-announcement",
    "stars": 391533,
    "updatedAt": 1784771328
  },
  {
    "id": "openclaw-openclaw-agents-skills-claw-score-skill-md",
    "name": "claw-score",
    "author": "openclaw",
    "description": "Audit or refresh OpenClaw maturity scorecard docs from root taxonomy, maturity scores, and QA evidence artifacts without using maintainer discrawl data or committed inventory reports.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/claw-score",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-claw-score",
    "stars": 391533,
    "updatedAt": 1787164243
  },
  {
    "id": "openclaw-openclaw-skills-healthcheck-skill-md",
    "name": "healthcheck",
    "author": "openclaw",
    "description": "Audit/harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, gateway security.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/healthcheck",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-healthcheck",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-skill-creator-skill-md",
    "name": "skill-creator",
    "author": "openclaw",
    "description": "Author or review AgentSkills: create, repair, validate, or restructure SKILL.md files and bundled resources.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/skill-creator",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-skill-creator",
    "stars": 391533,
    "updatedAt": 1786437360
  },
  {
    "id": "openclaw-openclaw-skills-things-mac-skill-md",
    "name": "things-mac",
    "author": "openclaw",
    "description": "Add, update, list, search, or inspect Things 3 todos, inbox, today, projects, areas, and tags on macOS.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/things-mac",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-things-mac",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-custodian-skills-configure-channel-skill-md",
    "name": "configure-channel",
    "author": "openclaw",
    "description": "Configure and prove a chat channel with non-interactive one-liners; secrets only as SecretRefs.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/custodian-skills/configure-channel",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/custodian-skills-configure-channel",
    "stars": 391533,
    "updatedAt": 1787124782
  },
  {
    "id": "openclaw-openclaw-agents-skills-discord-user-post-skill-md",
    "name": "discord-user-post",
    "author": "openclaw",
    "description": "Post an approved message as the logged-in Discord user through the Discord desktop app. Use for release announcements or other direct user-authored Discord posts; not for OpenClaw channel sends, bots, webhooks, relays, agent sessions, or archive search.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/discord-user-post",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-discord-user-post",
    "stars": 391533,
    "updatedAt": 1781515590
  },
  {
    "id": "openclaw-openclaw-agents-skills-discrawl-skill-md",
    "name": "discrawl",
    "author": "openclaw",
    "description": "Discord archive: search, sync freshness, DMs, summaries, TUI, repo/release work.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/discrawl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-discrawl",
    "stars": 391533,
    "updatedAt": 1780084972
  },
  {
    "id": "openclaw-openclaw-agents-skills-gitcrawl-skill-md",
    "name": "gitcrawl",
    "author": "openclaw",
    "description": "GitHub archive: issue/PR search, sync freshness, duplicate clusters, gh-shim PR status, and Gitcrawl repo work.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/gitcrawl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-gitcrawl",
    "stars": 391533,
    "updatedAt": 1779016703
  },
  {
    "id": "openclaw-openclaw-agents-skills-graincrawl-skill-md",
    "name": "graincrawl",
    "author": "openclaw",
    "description": "Granola archive: search, sync freshness, notes, transcripts, panels, SQL counts, and Graincrawl repo work.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/graincrawl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-graincrawl",
    "stars": 391533,
    "updatedAt": 1779016703
  },
  {
    "id": "openclaw-openclaw-agents-skills-notcrawl-skill-md",
    "name": "notcrawl",
    "author": "openclaw",
    "description": "Notion archive: search, sync freshness, pages/databases, Markdown exports, SQL counts, and Notcrawl repo work.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/notcrawl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-notcrawl",
    "stars": 391533,
    "updatedAt": 1779016703
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-refactor-docs-skill-md",
    "name": "openclaw-refactor-docs",
    "author": "openclaw",
    "description": "Refactor an existing OpenClaw docs page with source-audited preservation, restructuring, and verification.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-refactor-docs",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-refactor-docs",
    "stars": 391533,
    "updatedAt": 1786021045
  },
  {
    "id": "openclaw-openclaw-agents-skills-release-openclaw-plugin-testing-skill-md",
    "name": "release-openclaw-plugin-testing",
    "author": "openclaw",
    "description": "Plan and run pre-release OpenClaw plugin validation across bundled plugins, package artifacts, lifecycle commands, doctor/fix, config round-trip, gateway startup, SDK compatibility, Docker E2E, Package Acceptance, and Testbox proof.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-plugin-testing",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-plugin-testing",
    "stars": 391533,
    "updatedAt": 1786893904
  },
  {
    "id": "openclaw-openclaw-agents-skills-slacrawl-skill-md",
    "name": "slacrawl",
    "author": "openclaw",
    "description": "Slack archive: search, sync freshness, threads/DMs, SQL counts, and Slacrawl repo work.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/slacrawl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-slacrawl",
    "stars": 391533,
    "updatedAt": 1779016703
  },
  {
    "id": "openclaw-openclaw-agents-skills-technical-documentation-skill-md",
    "name": "technical-documentation",
    "author": "openclaw",
    "description": "Build and review high-quality technical docs as well as agent instruction files in your repository.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/technical-documentation",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-technical-documentation",
    "stars": 391533,
    "updatedAt": 1779690014
  },
  {
    "id": "openclaw-openclaw-extensions-memory-wiki-skills-obsidian-vault-maintainer-skill-md",
    "name": "obsidian-vault-maintainer",
    "author": "openclaw",
    "description": "Maintain an Obsidian-friendly memory wiki vault with wikilinks, frontmatter, and official Obsidian CLI awareness.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/memory-wiki/skills/obsidian-vault-maintainer",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-memory-wiki-skills-obsidian-vault-maintainer",
    "stars": 391533,
    "updatedAt": 1775447812
  },
  {
    "id": "openclaw-openclaw-skills-peekaboo-skill-md",
    "name": "peekaboo",
    "author": "openclaw",
    "description": "Capture and automate macOS UI with the Peekaboo CLI.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/peekaboo",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-peekaboo",
    "stars": 391533,
    "updatedAt": 1781529256
  },
  {
    "id": "openclaw-openclaw-skills-session-logs-skill-md",
    "name": "session-logs",
    "author": "openclaw",
    "description": "Search and analyze your own session logs (older/parent conversations) using jq.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/session-logs",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-session-logs",
    "stars": 391533,
    "updatedAt": 1782896878
  },
  {
    "id": "openclaw-openclaw-agents-skills-clawsweeper-skill-md",
    "name": "clawsweeper",
    "author": "openclaw",
    "description": "Use for all ClawSweeper work: OpenClaw issue/PR sweep reports, repair jobs, cloud fix PRs, @clawsweeper maintainer mention commands, trusted ClawSweeper-reviewed autofix/automerge, GitHub Actions monitoring, permissions, gates, and manual backfills.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/clawsweeper",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-clawsweeper",
    "stars": 391533,
    "updatedAt": 1786138748
  },
  {
    "id": "openclaw-openclaw-agents-skills-deslop-skill-md",
    "name": "deslop",
    "author": "openclaw",
    "description": "Diff-scoped AI-slop cleanup pass: strip comment slop, defensive-check slop, type-laundering, and style drift from the current branch diff before autoreview.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/deslop",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-deslop",
    "stars": 391533,
    "updatedAt": 1786856628
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-ci-limits-skill-md",
    "name": "openclaw-ci-limits",
    "author": "openclaw",
    "description": "Manage OpenClaw GitHub Actions and Blacksmith CI capacity, runner-registration budgets, fanout caps, main-push single-flight, shard sizing, hosted-runner offload, queue health, and safe ramp-down/ramp-up changes. Use when tuning `.github/workflows/*`, `docs/ci.md`, CI runner labels, matrix `max-parallel`, ClawSweeper/Blacksmith burst protection, CodeQL runner placement, or investigating slow/queued OpenClaw CI.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-ci-limits",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-ci-limits",
    "stars": 391533,
    "updatedAt": 1788349939
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-pr-maintainer-skill-md",
    "name": "openclaw-pr-maintainer",
    "author": "openclaw",
    "description": "Use immediately for any pasted OpenClaw GitHub issue or PR URL/number, and for OpenClaw issue/PR orchestration, review, triage, root-cause repair, PR rewrite, duplicate search, opener identity/who wrote it, author account age/activity, comments, labels, close, land, or maintainer evidence checks.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-pr-maintainer",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-pr-maintainer",
    "stars": 391533,
    "updatedAt": 1788204318
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-update-skill-md",
    "name": "openclaw-update",
    "author": "openclaw",
    "description": "Route routine updates of an existing local or remote OpenClaw Gateway to its installation owner, with automatic session recovery. Defer to deployment-specific skills when available.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-update",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-update",
    "stars": 391533,
    "updatedAt": 1788135564
  },
  {
    "id": "openclaw-openclaw-agents-skills-release-openclaw-nightly-skill-md",
    "name": "release-openclaw-nightly",
    "author": "openclaw",
    "description": "OpenClaw Tideclaw alpha/nightly release automation: isolated branches, local fixes, release CI, branch retention, and forward-port to main.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-nightly",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-release-openclaw-nightly",
    "stars": 391533,
    "updatedAt": 1786617936
  },
  {
    "id": "openclaw-openclaw-agents-skills-security-triage-skill-md",
    "name": "security-triage",
    "author": "openclaw",
    "description": "Triage OpenClaw security advisories, drafts, and GHSA reports with shipped-tag and trust-model proof.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/security-triage",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-security-triage",
    "stars": 391533,
    "updatedAt": 1779982239
  },
  {
    "id": "openclaw-openclaw-extensions-feishu-skills-feishu-drive-skill-md",
    "name": "feishu-drive",
    "author": "openclaw",
    "description": "Feishu cloud-storage and comment workflows. Activate when the user mentions cloud space, folders, Drive files, or document comments.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/feishu/skills/feishu-drive",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-feishu-skills-feishu-drive",
    "stars": 391533,
    "updatedAt": 1785803460
  },
  {
    "id": "openclaw-openclaw-extensions-feishu-skills-feishu-perm-skill-md",
    "name": "feishu-perm",
    "author": "openclaw",
    "description": "Feishu collaborator and permission workflows. Activate when the user explicitly asks to inspect or change sharing, permissions, or collaborators.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/feishu/skills/feishu-perm",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-feishu-skills-feishu-perm",
    "stars": 391533,
    "updatedAt": 1785803460
  },
  {
    "id": "openclaw-openclaw-skills-1password-skill-md",
    "name": "1password",
    "author": "openclaw",
    "description": "Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/1password",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-1password",
    "stars": 391533,
    "updatedAt": 1784791268
  },
  {
    "id": "openclaw-openclaw-skills-blogwatcher-skill-md",
    "name": "blogwatcher",
    "author": "openclaw",
    "description": "Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/blogwatcher",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-blogwatcher",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-notion-skill-md",
    "name": "notion",
    "author": "openclaw",
    "description": "Notion CLI/API for pages, Markdown content, data sources, files, comments, search, Workers, and raw API calls.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/notion",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-notion",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-openhue-skill-md",
    "name": "openhue",
    "author": "openclaw",
    "description": "Control Philips Hue lights and scenes via the OpenHue CLI.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/openhue",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-openhue",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-songsee-skill-md",
    "name": "songsee",
    "author": "openclaw",
    "description": "Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/songsee",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-songsee",
    "stars": 391533,
    "updatedAt": 1779015027
  },
  {
    "id": "openclaw-openclaw-skills-weather-skill-md",
    "name": "weather",
    "author": "openclaw",
    "description": "Current weather and forecasts with web_fetch, falling back to wttr.in curl for locations, rain, temperature, travel planning.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/weather",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-weather",
    "stars": 391533,
    "updatedAt": 1780684555
  },
  {
    "id": "openclaw-openclaw-skills-xurl-skill-md",
    "name": "xurl",
    "author": "openclaw",
    "description": "xurl CLI for authenticated X posts, replies, reads/search, DMs, media upload, followers, auth status, or raw v2 API calls.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/xurl",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-xurl",
    "stars": 391533,
    "updatedAt": 1783523229
  },
  {
    "id": "openclaw-openclaw-extensions-canvas-skills-canvas-skill-md",
    "name": "canvas",
    "author": "openclaw",
    "description": "Present hosted widget documents on a connected macOS panel and control panel visibility or navigation.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/extensions/canvas/skills/canvas",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/extensions-canvas-skills-canvas",
    "stars": 391533,
    "updatedAt": 1787152867
  },
  {
    "id": "openclaw-openclaw-skills-clawhub-skill-md",
    "name": "clawhub",
    "author": "openclaw",
    "description": "Search ClawHub for skills when a requested capability is not already available; install, verify, update, uninstall, publish, or sync skills.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/skills/clawhub",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/skills-clawhub",
    "stars": 391533,
    "updatedAt": 1785793142
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-release-validation-skill-md",
    "name": "openclaw-release-validation",
    "author": "openclaw",
    "description": "Test the latest OpenClaw main commit through an isolated OCM copy or an explicitly approved in-place gateway update, then guide structured release feedback.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-release-validation",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-release-validation",
    "stars": 391533,
    "updatedAt": 1788216778
  },
  {
    "id": "openclaw-openclaw-agents-skills-openclaw-repair-sweep-skill-md",
    "name": "openclaw-repair-sweep",
    "author": "openclaw",
    "description": "Orchestrate worker fleets over OpenClaw issues and PRs: prove root causes, prefer clean refactors over quick patches, land verified repairs, and close items proven fixed or no longer useful.",
    "contentLanguage": "en",
    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-repair-sweep",
    "skillUrl": "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-openclaw-repair-sweep",
    "stars": 391533,
    "updatedAt": 1788113107
  }
]

export const SKILL_COUNT = 56

/**
 * The same rows decoded by the catalog contract, exactly as an import holds them. Decoding here
 * rather than casting means a fixture the contract would reject fails at this import, not
 * silently later inside a search.
 */
export const DECODED: readonly SkillMarketplace.Skill[] = Schema.decodeUnknownSync(
  Schema.Array(SkillMarketplace.Skill),
)(SKILLS)
