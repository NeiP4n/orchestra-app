# Template Cleanup — removed and preserved built-in templates

Date: 2026-11-04. Base: `main` @ `9ffabbd`. Delivered directly to `main` at the operator's order.

## What was removed

Four built-in templates were removed from the normal built-in selection
(`Orchestra.templates` in `packages/schema/src/orchestra.ts`):

| ID | Why it was removed |
|---|---|
| `full` | Duplicated the general feature workflow with an arbitrary second developer |
| `factory` | Hardcoded a large team and a fixed five-stage pipeline |
| `pro-engineers` | Duplicated the Factory concept under another name |
| `proof-driven` | Its fixed team and verification process are superseded by dynamic stages and evidence-based completion (the `sessions` actions `plan`/`stage`/`verify`) |

## Compatibility — nothing the operator owns is deleted

- The four templates are preserved verbatim (roster + last playbook) in
  `Orchestra.legacyTemplates`, a compatibility record that is **not** offered
  for new projects and does not appear in `templates` or in template lists.
- A project created from a removed template keeps opening and running: its
  sessions already exist, and `Orchestra.playbook(projectID)` now resolves
  through `Orchestra.templateByID` — live template first, legacy record as
  fallback — so the project keeps the playbook it was created with.
- An operator's saved copy of a removed template (origin `edited`/`custom`)
  is stored data and is untouched: in the registry merge it simply becomes a
  custom template under the same id, and it always wins over the legacy
  record. Customized built-ins are never silently reset.
- Creating a NEW project from a removed id fails with the existing
  `TemplateNotFoundError` (HTTP 400), exactly like any unknown id — removal
  affects only the built-in selection, never stored data.
- No other template ids changed. `opencode-core` (the Orchestra Core team)
  is retained and modernized like the other kept templates.

## What was kept and modernized

Kept: `quick`, `feature`, `system`, `bugfix`, `ui`, `web-app`, `mobile-app`,
`desktop-app`, `research`, `docs`, `security-audit`, `deep-audit`,
`strategic-planning`, `release`, `opencode-core`. Their playbooks were
rewritten for dynamic orchestration — see `DYNAMIC_TEMPLATE_DESIGN.md`.

## References checked before deletion

`team_forge` (list/get/save), `workspace_forge` and federation texts
(session-per-template-role wording updated to the lazy model), the
Orchestrator system prompt, the project-creator and autonomous-developer
skills (which forced `factory`/`full`), and the test suites
(`orchestra-factory-verification`, `orchestra-role-quality`, server
`orchestra.test`) — all updated to the new contract.
