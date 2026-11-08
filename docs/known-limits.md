# Known limits

Current limits of the builds we ship, each line kept only while it is true;
when a limit is fixed and the fix is proven by a test, the line is replaced.

Pinned to 7eb3f976. Evidence levels: SOURCE (verified in the source tree at
the pinned commit, including tests that run under Bun against the source -
NOT verified in the compiled Node artifact), CI-CONFIG (what the workflow is
configured to do), CI-RUN (what a recorded run reported), UNKNOWN (not
established).

## Node artifact (cli-node)

The Node artifact currently lacks the Bun-backed project memory database and
codegraph index, and cannot send Windows media keys through Bun FFI. Basic
session storage uses a separate Node SQLite adapter. Session memory falls back
to the scrubbed file journal when the Bun sqlite engine cannot open (SOURCE,
verified under Bun by test/session-settle-capture.test.ts, an integrated
fixture that drives a real SessionStep through an injected engine-open
failure); settlement and journal durability in the compiled Node artifact
are not yet verified, and --version/--help smoke tests do not establish
working-session readiness. Use the Bun build for these features until the
Node adapters and session tests pass.

### What the artifact is

- SOURCE: packages/cli/vite.node.config.ts bundles packages/cli/src/node/index.ts
  into one minified ESM file with a prelude (extracts embedded assets,
  registers plugin module hooks, sets asset env vars) and defines
  ORCHESTRA_ARTIFACT="cli-node", version and channel; target node26. The Node
  SEA executable is a separate deliverable built from that bundle by
  script/build-node.ts.
- The output is NOT wholly standalone: @vscode/ripgrep stays external
  (vite.node.config.ts:295-299) so its lazy PATH/download fallback survives
  the bundle.
- SOURCE: script/build-node.ts:17 pins NODE_VERSION = 26.4.0;
  packages/cli/src/node/target.ts:39 sets the exec flags
  `--experimental-ffi --use-system-ca --disable-warning=ExperimentalWarning`.

### Runtime Node support

- CI-CONFIG: .github/workflows/test.yml installs Node 26.4.0 for the verify
  step on both OS.
- UNKNOWN: the supported Node range. 26.4.0 is the configured pin, not a
  stated minimum; nothing in README.md, ARCHITECTURE.md or docs/ states one.

### Bun-only paths and their gates

- SOURCE: vite.node.config.ts aliases `bun`, `bun:sqlite` and `bun:ffi` to
  throwing shims under packages/cli/src/node/ so the bundler can resolve the
  static imports; loading is harmless, construction or invocation throws.
- Updater: SOURCE source-release.ts reports unsupported for the cli-node
  artifact and the message names the Bun source installation; the refusal
  scopes to source-checkout/local-channel updates, package-manager upgrade
  stays supported. Covered by test/source-release-guard.test.ts and, since
  a5631b8f, by an upgrade.test.ts case that drives the real Updater service
  (test/fixture/updater-service.ts) under Bun with node-artifact defines.
  UNKNOWN: the refusal inside the compiled artifact.
- Memory tool: SOURCE tool/plugin/memory.ts refuses before any mkdir,
  database open or write when the Bun runtime is absent (c70b69ce), naming
  the Bun-backed requirement. An operational open failure under Bun reports
  the real cause instead; "unavailable in this build" is reserved for the
  missing-runtime case and never describes a caught operational error.
  UNKNOWN: behavior in the compiled artifact.
- Codegraph: SOURCE tool/plugin/codegraph.ts (76b92ca5, seam rewired in
  c70b69ce) answers every action with an explicit unavailable message as a
  normal tool-text result (not an error-channel failure) before any mkdir or
  write; status no longer says "build the index" on a build without the Bun
  sqlite engine. Only the tool's answer path is gated - other indexer or
  database callers are not covered by this refusal. UNKNOWN: behavior in the
  compiled artifact.
- Desktop media keys: SOURCE tool/plugin/desktop-action.ts rejects win32
  media keys before the FFI call with an explicit Bun-FFI message (f759cc07,
  seam rewired in c70b69ce); non-media PowerShell dispatch is unaffected and
  the real-screen permission denial stays first, ahead of the media guard.
  FFIType references are lazy inside openUser32() (227-230),
  mediaLibraryReady has no call site, and pressMedia is wrapped in
  Effect.try (609-617). Covered by test/node-build-guards.test.ts under Bun
  with the runtime seam and desktop host mocked. UNKNOWN: Windows behavior
  in the compiled artifact.

### Session memory and journals

- The synchronous openSessionEngine acquisition that escaped
  notifyToolSettled's catch (llm.ts argument evaluation, before the Effect
  existed) was a verified source defect. FIXED at ba682091 and reworked at
  b31aad26: the capture is suspended and lives in the exported
  toolSettledCapture seam, the engine opens through the never-throwing
  tryOpenSessionEngine, the step settles, and the scrubbed file journal
  stays the record. Failure handling now splits two cases: a missing Bun
  runtime is a capability absence, cached with one warning per project
  directory; any other engine-open failure is operational, warns once per
  failure streak, and the next attempt retries - no directory is poisoned
  for the process lifetime. Verified under Bun by
  test/session-settle-capture.test.ts (integrated fixture: real SessionStep,
  injected engine-open throw, result publishes, scrubbed journal appended,
  warning exactly once, retry-then-recovery) and test/session-memory.test.ts.
- SOURCE: the journal append (.orchestra/sessions/<id>/journal.jsonl) and the
  engine write path are unchanged; the engine lives at .orchestra/memory.db.
- Finalize: SOURCE session/execution.ts:187-209 — the extractive finalize is
  wired, the LLM cheap-model summary is not wired at settle (injectable
  through finalizeSession's options). No durability guarantee on Node.
- UNKNOWN: ordinary tool settle plus journal durability in the compiled
  artifact; autoloop journal behavior in the compiled artifact.

### Version and eager initializers

- SOURCE: version.ts reads the injected defines first; module-level
  initializers spawn git describe/rev-parse and existsSync as fallbacks, and
  REPO_ROOT derives unguarded from import.meta.url.
- UNKNOWN: whether those initializers survive minification and run in the
  artifact; REPO_ROOT at an installed location; SEA import.meta.url
  semantics; startup cost.

### CI coverage

- CI-CONFIG: test.yml "Verify Node build" (155-163) builds the artifact and
  runs packages/cli/script/service-smoke.ts --node under Node 26.4.0 on Linux
  and Windows. The smoke spawns `serve --service` and checks service
  registration, auth/unauth HTTP, web UI, plugin discovery, single-owner
  election, clean stop and cleanup. --version/--help ARE exercised
  transitively: script/build-node.ts runs them on the host bundle (105-109)
  and on a relocated copy (221-230). The smoke checks exit codes only.
- CI-RUN at 82d87199 (Nov 7, point-in-time): typecheck success; unit Linux
  failed at "Run affected unit suite", so the verify step was skipped on
  Linux; the Windows run was cancelled. Job logs returned 403.
- CI-RUN at 4d1ef63e: both OS "Verify Node build" steps reported success by
  API (run 42423856383); output/artifact correspondence not verified.
- The 6c dispatch run (workflow_dispatch, full unit suite plus e2e) passed
  its earlier jobs but was cancelled mid-run by a newer push; a fresh
  same-SHA dispatch on the reworked code is pending. A passing smoke is a
  Node build smoke result, not a feature certification.
- Omissions: no step exercises the updater refusal, memory/codegraph gates,
  media keys or an ordinary tool settle in the compiled artifact; the unit
  suite runs under Bun, not the compiled artifact.

### Open unknowns

- Supported Node range (26.4.0 is the configured pin, not a stated minimum).
- Eager initializer retention, relocated roots in a real session, SEA
  import.meta.url semantics, startup cost.
- Runtime surfacing of the updater refusal, the memory/codegraph gates and
  Windows media keys in the compiled artifact.
- Ordinary tool settle plus journal durability in the compiled artifact.
