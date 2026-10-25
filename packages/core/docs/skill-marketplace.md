# Skill catalog

## Purpose

Find published agent skills on SkillsMP and use them, without asking the catalog twice.
The service keeps what it has seen **inside the current project** (`.opencode/skill-catalog/`),
so a repeated search is answered from disk and costs no request at all. Only a query the
project's cache cannot answer goes out to the network, and a skill is ever kept **globally**
only when the model passes `save: "global"` and the user allows it.

The catalog has no category list and no per-skill endpoint; a skill's text is not on the catalog
at all — it is the `SKILL.md` in the skill's GitHub repository.

## Structure

- `skill-marketplace/upstream.ts` — the official entry point `POST https://skillsmp.com/mcp`:
  JSON-RPC `initialize`, `notifications/initialized`, then `tools/call` on `search_skills`.
  Sends `MCP-Protocol-Version: 2025-06-18` and carries the `Mcp-Session-Id` the server hands back
  (this endpoint is stateless and sends none). `MIN_INTERVAL` (2.1 s) keeps calls at the documented
  rate of thirty per minute per IP; nothing here retries, because one refusal turned into several
  is how a client gets itself blocked. The answer is decoded with `SkillMarketplace.parse`.
- `skill-marketplace/store.ts` — the cache: NDJSON, one decoded catalog row per line, in
  `<project>/.opencode/skill-catalog/skills.jsonl`, written temp+rename. A damaged line costs the
  whole cache and says which line: a plausible subset would answer queries with something the
  caller cannot tell from the truth.
- `skill-marketplace/search.ts` — an inverted index built over the cache in memory (term → rows,
  split by the field it was found in) and the ranking: a name hit weighs ten times a description
  hit, the whole query inside one field beats the same words scattered, `stars` breaks a tie.
- `skill-marketplace/read.ts` — the skill text from GitHub (`raw.githubusercontent.com`, derived
  from the row's `githubUrl`), and `apply`, which writes it to `<project>/.opencode/skills/<name>/SKILL.md`
  where the project's own loader will find it.
- `skill-marketplace/save.ts` — the one global write: `SKILL.md` into
  `<global config>/skills/<name>/`, the directory the config loader already scans.
- `skill-marketplace/scan.ts` — a native static scan modelled on NVIDIA SkillSpector's first stage
  (regex rules by threat category, severity weights 50/25/10/5, score bands SAFE / CAUTION / DO NOT INSTALL).
  `scan` checks without writing; `read` and `save` run it themselves and refuse a DO NOT INSTALL skill, so
  nothing blocked reaches `.opencode/skills`. It reads only `SKILL.md`: no scripts, CVE lookup or model review,
  so SAFE means "no known bad pattern in the text".
- `skill-marketplace/index.ts` — the Location-scoped service (`makeLocationNode`, deps
  `Global.node` and `Location.node`) with `search`, `read`, `save` and `stats`.
- `tool/plugin/skill-catalog.ts` — the `skill_catalog` tool over that service.

## Entry Points

- `SkillMarketplace.Service.search({ query, limit?, language?, category?, sortBy? })` — answers
  from the project cache when it can, and says so with `cached: true`.
- `SkillMarketplace.Service.read({ name })` — the text; the project copy is written either way.
- `SkillMarketplace.Service.save({ name })` — keeps the skill for good. Nothing else calls it.
- `SkillMarketplaceUpstream.search(query, options?)` — one catalog call, decoded.

## Why the cache is per project

A cache of what the catalog said is knowledge about the work, not about the machine: it belongs
next to the `.opencode` state of the project that asked. Two projects therefore never share an
answer (there is a test for exactly that), and a directory that travels with a repository can be
committed, deleted or ignored on its own terms. Global state stays for the one thing that is
genuinely global — a skill the user decided to keep.

## Consumers

The model through the `skill_catalog` tool; the instruction in `instructions/builtins.ts` tells
it to check the catalog at the start of a new task. Tests: `test/skill-marketplace-store.test.ts`,
`-search`, `-upstream`, `-read`, `-service` and `test/tool-skill-catalog.test.ts`.

## Pitfalls

- The permission checks keep the strings `skillsmp_search_skills` and `skillsmp_get_skill` even
  though nothing calls that MCP server any more: the user has saved allow/deny rules under those
  names, and renaming the resource would silently stop those rules applying.
- A `category` or a `sort` filter always asks the catalog. The cached rows carry no category and
  rank by score and stars, so answering from the cache would quietly ignore the filter.
- A refusal — non-200, a JSON-RPC error, a result marked `isError`, or a body the contract
  rejects — becomes `UpstreamError` and never reaches the cache.
- `save: "global"` writes outside the project, so it asks permission under the `skill` action
  separately; without it a search or a read only ever writes into the project.
- A 403 with an HTML body is the edge refusing the protocol version, not a rate limit and not a
  blocked network; the status is reported as an upstream refusal and nothing is cached.
