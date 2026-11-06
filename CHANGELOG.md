# Changelog

All notable changes to Orchestra are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A release is a commit
on `main` plus an entry in `releases.json` — no git tags, because tags cannot be
created through the snapshot-push flow that publishes this repository. A release
is two commits: the bump commit (version + this file) and the registry commit
that records the bump commit's SHA in `releases.json`.

## [1.0.0] - 2026-11-06

First Orchestra release: own versioning starts at 1.0.0, never from upstream OpenCode.

### Added

- Autoloop safety core: stop-word on the 3rd repeat error, test-before-fix, one lesson after the 2nd failure, two independent verifications, dispute ladder with timers.
- Independent review: red team, evidence-weighted voting, foreign checklist review, dual architecture review, user-eyes acceptance.
- Rules and memory: ask-first (3 questions), ADR records, handoff at every stop, cold-start sprint, knowledge map.
- DoD: standby reserve, WIP limit 3, module contracts, integration window, rollback plan, zones with customs, kanban board view.
- Verification quality: mutation testing, clean build from scratch, shadow orchestrator.
- Server watchdog, shutdown marker, PID lock (silent server death fix).
- Role toolkits for 7 roles, live-provider-only models with cross-provider fallback, context compaction.
- Activation fix: workers are resumed after dispatch, kickoff redelivery.
- Prompt-intake module: value check, understanding, cheap-model disambiguation, skill recommendations.
- Native skill marketplace: 3-level factory, mismatch resolution, hard 10,000-token per-request budget.
- Recovery mini-chat ("Исправить"): repairs a broken Orchestra from /recovery without the app shell.
- Desktop and serve redesign: dark tokens follow the app scheme, single z-index scale, Fan mark, neural effects.
- Version and upgrade from Orchestra's own package.json and GitHub releases (1.0.0).
