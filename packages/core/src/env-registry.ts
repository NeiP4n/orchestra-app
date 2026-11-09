export * as EnvRegistry from "./env-registry.js"

/**
 * The registry of every `ORCHESTRA_*` environment variable the runtime
 * reads (arch3 №10) — one source of truth with the name, what it does, and
 * the default when unset. A typo in a variable name used to silently fall
 * back to the default; `test/env-registry.test.ts` scans every package's
 * `src` directory for `process.env.ORCHESTRA_*` (and injected-`env` reads)
 * and fails when a name the code reads is missing here, or a name here is
 * no longer read.
 *
 * Scope: `ORCHESTRA_*` only. Variables owned by someone else are not
 * registered here: provider-SDK variables (`AWS_*`, `GOOGLE_*`,
 * `ANTHROPIC_*`, …), the OS and shell (`PATH`, `HOME`, `SHELL`, `TERM`,
 * …), Node/Bun (`NODE_ENV`). The `OPENCODE_*` legacy aliases were
 * removed; the only ones still read are the PTY fallbacks
 * (`OPENCODE_PTY_BIN`, `OPENCODE_NODE_PTY_PATH`), named in the `default`
 * of the `ORCHESTRA_*` variable that falls back to them. Build-time defines
 * (`VITE_*`) are not runtime environment reads and are not registered
 * either; `ORCHESTRA_CHANNEL` and `ORCHESTRA_VERSION` are defines too,
 * but the install script also reads them from `process.env` at runtime,
 * so they are registered below with that note.
 */

export interface EnvVar {
  /** What the variable does, in one line. */
  readonly purpose: string
  /** The value used when the variable is unset, in words. Omit when unset means off/absent. */
  readonly default?: string
  /**
   * How the value is read. `process.env` (the default) is a direct read;
   * `injected-env` is read from an `env` object handed in (desktop
   * isolation, limits, the gateway config, the TUI glyph check), which is
   * `process.env` in production and a test double in tests.
   */
  readonly readIn?: "injected-env"
  /** Orchestra itself sets this variable for a child process; the operator does not set it. */
  readonly setBy?: string
  /**
   * Documented but with no live read in TypeScript (legacy or consumed by a
   * native binding). Kept so the name is not reintroduced blindly; the
   * registry test does not require a code read for these.
   */
  readonly legacy?: true
}

export const ENV_REGISTRY: Readonly<Record<string, EnvVar>> = {
  ORCHESTRA_ACTIVATION_CHECK_MINUTES: {
    purpose: "Minutes between activation checks for idle workers.",
    default: "5",
  },
  ORCHESTRA_AGENT_CURSOR: {
    purpose: "Show the agent's cursor in the Browser tab where its browser tool clicked or typed (\"0\" turns it off).",
    default: "On.",
  },
  ORCHESTRA_API_KEY: {
    purpose: "API key for the opencode provider, used when no stored credential exists.",
  },
  ORCHESTRA_BASIC_SYMBOLS: {
    purpose: "Force the TUI to use basic glyphs (\"1\") or not (\"0\").",
    default: "Auto-detected from the terminal.",
    readIn: "injected-env",
  },
  ORCHESTRA_BROWSER_CDP_URL: {
    purpose: "CDP HTTP endpoint for the local browser plugin.",
    default: "\"http://127.0.0.1:9222\"",
    readIn: "injected-env",
  },
  ORCHESTRA_BROWSER_DEBUG: {
    purpose: "Show the Browser tab's input debug lines on screen (\"1\"). The log file is always written.",
    default: "Off.",
  },
  ORCHESTRA_BROWSER_GFX: {
    purpose: "How the Browser tab draws the page: \"sixel\", \"kitty\", \"blocks\" (quadrant block characters) or \"auto\" (the renderer detects the terminal's graphics).",
    default: "Windows: blocks. Elsewhere: auto.",
  },
  ORCHESTRA_BROWSER_HALFBLOCKS: {
    purpose: "Draw the Browser tab's page as colored block characters (\"1\") instead of kitty or sixel graphics, for terminals that print graphics data as text. \"0\" asks for the terminal's own graphics even on Windows.",
    default: "On for Windows, off elsewhere (the terminal's graphics protocol is detected).",
  },
  ORCHESTRA_BROWSER_LAUNCHER: {
    purpose: "Shell command that starts the browser when the CDP endpoint does not answer.",
    readIn: "injected-env",
  },
  ORCHESTRA_BROWSER_LOCAL: {
    purpose: "Local browser for the browser plugin (\"0\" disables it).",
    default: "Enabled.",
  },
  ORCHESTRA_BROWSER_PIXEL_MOUSE: {
    purpose: "Pixel-exact pointer in the Browser tab while control is on (\"0\" turns it off).",
    default: "On; falls back to terminal cells when the terminal sends no pixel reports.",
  },
  ORCHESTRA_BROWSER_PLUGIN: {
    purpose: "Offer the browser plugin (browser.tabs.*, its own Chromium on a debugging port) to agents (\"1\"). The `browser` tool tied to the Browser tab is always offered.",
    default: "Off.",
  },
  ORCHESTRA_BROWSER_PROFILE: {
    purpose: "Profile directory for the browser plugin's built-in launch.",
    default: "\"<data>/orchestra/browser-profile\" (the opencode profile when it exists and the orchestra one does not).",
    readIn: "injected-env",
  },
  ORCHESTRA_BROWSER_SCALE: {
    purpose: "Device scale (1 to 3) of the Browser tab's captured Chrome; 2 draws Chrome's own tabs and buttons twice as large.",
    default: "1.",
  },
  ORCHESTRA_BROWSER_STRIP_SNAP: {
    purpose: "Moves pointer events in Chrome's tab strip to the strip's centre line so the close button can be hit (\"0\" turns it off).",
    default: "On.",
  },
  ORCHESTRA_BUMP: {
    purpose: "Release version bump for the script build (\"major\"/\"minor\"/\"patch\").",
    default: "The version in package.json.",
  },
  ORCHESTRA_CACHE_DIR: {
    purpose: "Override for the cache directory.",
    default: "The platform cache directory.",
  },
  ORCHESTRA_CHANNEL: {
    purpose: "Release channel for the script build; overrides the channel derived from the git branch. (Also a build-time define elsewhere — this entry is the script's runtime read.)",
    default: "The current git branch (\"detached\" without one).",
  },
  ORCHESTRA_CHROME_PATH: {
    purpose: "Full path of the Chrome or Edge executable the Browser tab starts, when the usual install places are not used.",
    default: "Off: the usual install places are searched.",
  },
  ORCHESTRA_CLIENT: {
    purpose: "Client name reported to the server (for example \"acp\").",
    default: "The built artifact name.",
  },
  ORCHESTRA_CLI_CONFIG_CONTENT: {
    purpose: "Full CLI config as JSON text, injected instead of read from a file.",
  },
  ORCHESTRA_COMMAND: {
    purpose: "Command used to spawn orchestra from the TUI.",
    default: "\"orchestra\"",
  },
  ORCHESTRA_COMPLETION_NUDGES: {
    purpose: "How many completion nudges a session gets.",
    default: "3.",
  },
  ORCHESTRA_CONFIG: {
    purpose: "Path to the orchestra.json config file.",
    default: "Standard config discovery.",
  },
  ORCHESTRA_CONFIG_CONTENT: {
    purpose: "Config file content as text, injected instead of read from a file.",
  },
  ORCHESTRA_CONFIG_DIR: {
    purpose: "Override for the config directory.",
    default: "The platform config directory.",
  },
  ORCHESTRA_CONFIG_PROJECT_DISABLE: {
    purpose: "Disable project-level config (alias: ORCHESTRA_DISABLE_PROJECT_CONFIG).",
    default: "Project config enabled.",
  },
  ORCHESTRA_CONTEXT_DENSIFY: {
    purpose: "Lossless densification of repeated JSON arrays in tool results (\"1\"/\"true\" on).",
    default: "Off.",
  },
  ORCHESTRA_CONTEXT_GOVERNOR: {
    purpose: "Context governor on/off (\"1\"/\"true\" on, \"0\"/\"false\" off).",
    default: "On unless the config turns it off.",
  },
  ORCHESTRA_CONTEXT_GOVERNOR_SOFT: {
    purpose: "Soft token budget for the context governor.",
    default: "80000",
  },
  ORCHESTRA_CREDENTIAL_KEY_FILE: {
    purpose: "Path to the file holding the credential-encryption key.",
    default: "The key file in the data directory.",
  },
  ORCHESTRA_DATA_DIR: {
    purpose: "Override for the data directory.",
    default: "The platform data directory.",
  },
  ORCHESTRA_DB: {
    purpose: "Path to the SQLite database (\":memory:\" for an in-memory database).",
    default: "The standard database path.",
  },
  ORCHESTRA_DESKTOP_CAPTURE: {
    purpose: "Allow desktop access on the virtual display (\"on\"). Without it every desktop tool refuses.",
    default: "Off.",
    readIn: "injected-env",
  },
  ORCHESTRA_DESKTOP_CLI_DEV: {
    purpose: "Run the desktop CLI in development mode (unpackaged builds).",
    default: "Off.",
  },
  ORCHESTRA_DESKTOP_DISABLE_PROTOCOL_REGISTRATION: {
    purpose: "Skip orchestra:// protocol registration in unpackaged builds (\"1\").",
    default: "Registered.",
  },
  ORCHESTRA_DESKTOP_ISOLATED_SERVER: {
    purpose: "Run the desktop's background server isolated in development (\"1\").",
    default: "Off.",
  },
  ORCHESTRA_DESKTOP_REAL_SCREEN: {
    purpose: "Allow tools on the operator's real screen (\"on\", together with the allowlist and a future expiry).",
    default: "Off.",
    readIn: "injected-env",
  },
  ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST: {
    purpose: "Apps allowed on the real screen, for ORCHESTRA_DESKTOP_REAL_SCREEN.",
    default: "No app allowed.",
    readIn: "injected-env",
  },
  ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL: {
    purpose: "Expiry (ISO date) of the real-screen opt-in.",
    default: "No expiry.",
    readIn: "injected-env",
  },
  ORCHESTRA_DESKTOP_REMOTE_DEBUGGING_PORT: {
    purpose: "Electron remote-debugging port for the desktop app.",
    default: "9222",
  },
  ORCHESTRA_DESKTOP_SERVER_CHANNEL: {
    purpose: "Server channel for the desktop's isolated background server (\"local\" selects the local channel).",
  },
  ORCHESTRA_DESKTOP_TEST_ROOT: {
    purpose: "Root directory for desktop tests (unpackaged builds).",
  },
  ORCHESTRA_DESKTOP_WSL_CLI_BUILD: {
    purpose: "Build script for the desktop WSL CLI (together with ORCHESTRA_DESKTOP_WSL_CLI_OUTPUT).",
  },
  ORCHESTRA_DESKTOP_WSL_CLI_OUTPUT: {
    purpose: "Output path for the desktop WSL CLI build (together with ORCHESTRA_DESKTOP_WSL_CLI_BUILD).",
  },
  ORCHESTRA_DIRECT_TRACE: {
    purpose: "Print direct traces in the mini-host.",
    default: "Off.",
  },
  ORCHESTRA_DISABLE_AUTOUPDATE: {
    purpose: "Disable automatic updates (\"1\"/\"true\").",
    default: "Updates enabled.",
  },
  ORCHESTRA_DISABLE_CHANNEL_DB: {
    purpose: "Disable the per-channel database (\"1\"/\"true\").",
    default: "Enabled.",
  },
  ORCHESTRA_DISABLE_EMBEDDED_WEB_UI: {
    purpose: "Disable the embedded web UI (set by the desktop to \"true\").",
    default: "Off.",
    setBy: "The desktop app.",
  },
  ORCHESTRA_DISABLE_FFF: {
    purpose: "Disable the fff file search.",
    default: "On, except on Windows where it is off unless set to \"0\".",
  },
  ORCHESTRA_DISABLE_FILEWATCHER: {
    purpose: "Disable the file watcher (alias: ORCHESTRA_FILEWATCHER_DISABLE).",
    default: "Watcher enabled.",
  },
  ORCHESTRA_DISABLE_LIMITS: {
    purpose: "Opt out of step/token limits (\"1\"); ORCHESTRA_ENFORCE_LIMITS=1 still forces them on.",
    default: "Limits enforced.",
    readIn: "injected-env",
  },
  ORCHESTRA_DISABLE_MODELS_FETCH: {
    purpose: "Do not fetch the models list from the network.",
    default: "Fetching enabled.",
  },
  ORCHESTRA_DISABLE_PROJECT_CONFIG: {
    purpose: "Disable project-level config (alias: ORCHESTRA_CONFIG_PROJECT_DISABLE).",
    default: "Project config enabled.",
  },
  ORCHESTRA_DOCS_URL: {
    purpose: "Docs URL opened from the TUI.",
    default: "The GitHub README URL.",
  },
  ORCHESTRA_DRAIN_TOKEN_BUDGET: {
    purpose: "Token budget for a session drain (only while limits are enforced).",
    default: "10000000",
    readIn: "injected-env",
  },
  ORCHESTRA_DRAIN_WALL_CLOCK_MS: {
    purpose: "Wall-clock budget in milliseconds for a session drain (only while limits are enforced).",
    default: "14400000 (4h)",
    readIn: "injected-env",
  },
  ORCHESTRA_DRIVE: {
    purpose: "Run the Drive simulation frontend in the TUI instead of the normal renderer.",
    default: "Off.",
  },
  ORCHESTRA_EDITOR_SSE_PORT: {
    purpose: "Port of the editor SSE bridge.",
    default: "None (falls back to CLAUDE_CODE_SSE_PORT).",
  },
  ORCHESTRA_ENFORCE_LIMITS: {
    purpose: "Force step/token limits on (\"1\"), even when ORCHESTRA_DISABLE_LIMITS is set.",
    default: "Limits enforced unless disabled.",
    readIn: "injected-env",
  },
  ORCHESTRA_EXPERIMENTAL_FILEWATCHER: {
    purpose:
      "Enable the file watcher for the entire directory (documented in the CLI docs; no TypeScript read in this repo — consumed by the watcher binding or legacy).",
    legacy: true,
  },
  ORCHESTRA_FAST_BOOT: {
    purpose: "Skip the TUI's initial loading screen.",
    default: "Off.",
  },
  ORCHESTRA_FILEWATCHER_DISABLE: {
    purpose: "Disable the file watcher (alias: ORCHESTRA_DISABLE_FILEWATCHER).",
    default: "Watcher enabled.",
  },
  ORCHESTRA_FREEBUFF_CONTEXT: {
    purpose: "Minimum context-window floor for freebuff models (only ever raises the catalog value).",
  },
  ORCHESTRA_GATEWAY_FALLBACK_MODELS: {
    purpose: "Gateway fallback models, comma-separated.",
    default: "None.",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_HOST: {
    purpose: "Host the gateway listens on.",
    default: "127.0.0.1",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_MODEL: {
    purpose: "Model the gateway serves.",
    default: "\"glm-4.7-free\"",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_PORT: {
    purpose: "Port the gateway listens on.",
    default: "8789",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_ROOM_API_URL: {
    purpose: "Room API URL for gateway room-token authorization (together with ORCHESTRA_GATEWAY_ROOM_ID).",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_ROOM_ID: {
    purpose: "Room id for gateway room-token authorization (together with ORCHESTRA_GATEWAY_ROOM_API_URL).",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GATEWAY_TIMEOUT_MS: {
    purpose: "Gateway request timeout in milliseconds (1000–600000).",
    default: "120000",
    readIn: "injected-env",
  },
  ORCHESTRA_GATEWAY_TOKEN: {
    purpose: "Gateway auth token (at least 32 characters; alternative to room-token authorization).",
    readIn: "injected-env",
  },
  ORCHESTRA_GATEWAY_UPSTREAM_KEY: {
    purpose: "Upstream API key for the gateway (required; never leaves this host).",
    readIn: "injected-env",
  },
  ORCHESTRA_GATEWAY_UPSTREAM_URL: {
    purpose: "Upstream chat-completions URL for the gateway.",
    default: "\"https://opencode.ai/zen/v1/chat/completions\"",
    readIn: "injected-env",
    setBy: "`orchestra gateway`",
  },
  ORCHESTRA_GITHUB_REPO: {
    purpose: "GitHub repository used for updates.",
    default: "\"NeiP4n/orchestra-app\"",
  },
  ORCHESTRA_GIT_BASH_PATH: {
    purpose: "Path to git bash on Windows.",
    default: "Auto-detected.",
  },
  ORCHESTRA_IDEA_BANK_URL: {
    purpose: "Base URL of the shared Idea Bank service; without it the idea-bank tool reports itself unconnected.",
  },
  ORCHESTRA_INSTALLER_URL: {
    purpose: "Installer URL for the remote CLI (falls back to ORCHESTRA_INSTALL_URL).",
  },
  ORCHESTRA_INSTALL_URL: {
    purpose: "Install-script URL for updates.",
    default: "<update URL>/install",
  },
  ORCHESTRA_INSTRUCTION_ROUTER: {
    purpose: "Instruction router on/off (\"off\" disables).",
    default: "On.",
  },
  ORCHESTRA_LOG_LEVEL: {
    purpose: "Minimum log level (DEBUG/INFO/WARN/ERROR).",
    default: "INFO",
  },
  ORCHESTRA_MCP_CHROME_DEVTOOLS: {
    purpose: "Let acquisition install the chrome-devtools MCP server, which starts a Chrome of its own (\"1\"). The `browser` tool is used otherwise.",
    default: "Off.",
  },
  ORCHESTRA_MCP_PER_DIRECTORY: {
    purpose: "Run MCP servers with the project directory as their working directory.",
    default: "Off (empty working directory).",
  },
  ORCHESTRA_MCP_PLAYWRIGHT: {
    purpose: "Let acquisition install the playwright MCP server, which starts a Chrome of its own (\"1\"). The `browser` tool is used otherwise.",
    default: "Off.",
  },
  ORCHESTRA_MODELS_PATH: {
    purpose: "Path to a local models file.",
  },
  ORCHESTRA_MODELS_URL: {
    purpose: "URL to fetch the models list from.",
  },
  ORCHESTRA_MOTION: {
    purpose: "Force neural animations on in tests (\"1\").",
    default: "Animations off in tests.",
  },
  ORCHESTRA_NODE_ASSETS_DIR: {
    purpose: "Directory holding node assets (attention sounds).",
  },
  ORCHESTRA_NODE_PTY_PATH: {
    purpose: "Module path for node-pty.",
    default: "\"@lydell/node-pty\" (falls back to OPENCODE_NODE_PTY_PATH).",
  },
  ORCHESTRA_NO_MOTION: {
    purpose: "Disable TUI animations (\"1\").",
    default: "Animations on.",
  },
  ORCHESTRA_PARCEL_WATCHER_PATH: {
    purpose: "Module path for the parcel watcher binding.",
    default: "The bundled platform binding.",
  },
  ORCHESTRA_PASSWORD: {
    purpose: "Server password (legacy name; prefer ORCHESTRA_SERVER_PASSWORD).",
    default: "Generated and stored in the 0600 service config.",
  },
  ORCHESTRA_PHOTON_WASM_PATH: {
    purpose: "Path to the photon wasm file.",
    default: "The bundled wasm.",
  },
  ORCHESTRA_PP_BRANCH: {
    purpose: "Update branch for the plus-plus source install.",
    default: "\"main\" (falling back to \"lan-rooms\").",
  },
  ORCHESTRA_PP_MOBILE: {
    purpose: "Use the mobile TUI layout (set by the Termux command, \"1\").",
    default: "Off.",
  },
  ORCHESTRA_PRINT_LOGS: {
    purpose: "Print child-process logs to stderr (\"1\").",
    default: "Off.",
  },
  ORCHESTRA_PROXY_PROBE: {
    purpose: "Proxy probing (\"0\" disables).",
    default: "Probing enabled.",
  },
  ORCHESTRA_PTY_BIN: {
    purpose: "Persistent PTY binary.",
    default: "\"opencode-pty\" (falls back to OPENCODE_PTY_BIN).",
  },
  ORCHESTRA_PTY_HANDOFF: {
    purpose: "PTY restart handoff as JSON, consumed once on startup.",
    setBy: "The server on restart.",
  },
  ORCHESTRA_RELEASE: {
    purpose: "Mark the script build as a release build (any value).",
    default: "Preview build.",
  },
  ORCHESTRA_RELEASE_CHANNEL: {
    purpose: "Release channel for the update host (\"beta\" selects beta releases, anything else selects latest).",
    default: "\"latest\".",
  },
  ORCHESTRA_REPO_CLONE_GITHUB_BASE_URL: {
    purpose: "Base URL for cloning GitHub repositories.",
    default: "github.com.",
  },
  ORCHESTRA_REPO_ROOT: {
    purpose: "Override for the repository root the recovery service repairs.",
    default: "The ancestor directory holding packages/core.",
  },
  ORCHESTRA_REQUEST_MEASUREMENT: {
    purpose: "\"1\" collects numbers-only measurements of each model request (sizes and counts, no text).",
    default: "Off.",
  },
  ORCHESTRA_REQUEST_MEASUREMENT_DIR: {
    purpose: "Folder the request measurements are written to.",
    default: "The measurements folder inside the app log folder.",
  },
  ORCHESTRA_REQUEST_MEASUREMENT_RETENTION_DAYS: {
    purpose: "How many days request measurement files are kept.",
    default: "The built-in retention.",
  },
  ORCHESTRA_REQUEST_REPORT: {
    purpose: "Enable per-request reports (any value).",
    default: "Off.",
  },
  ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS: {
    purpose: "How many days request reports are kept.",
    default: "7",
  },
  ORCHESTRA_ROUTE: {
    purpose: "Initial TUI route as JSON.",
  },
  ORCHESTRA_SERVER_PASSWORD: {
    purpose: "Server password (preferred name; ORCHESTRA_PASSWORD is the legacy name).",
    default: "Generated and stored in the 0600 service config.",
  },
  ORCHESTRA_SERVER_URL: {
    purpose: "Server URL for the plugin client (removed with the OpenCode plugin connector; kept so the name is not reintroduced blindly).",
    default: "\"http://127.0.0.1:4096\"",
    legacy: true,
  },
  ORCHESTRA_SESSION_ID: {
    purpose: "Session id of the invoking session, visible to child processes.",
    setBy: "The shell and hub tools.",
  },
  ORCHESTRA_SESSION_ROOT: {
    purpose: "Session-root override for the native skill marketplace.",
  },
  ORCHESTRA_SHOW_TTFD: {
    purpose: "Show time-to-first-token timing (\"1\"/\"true\").",
    default: "Off.",
  },
  ORCHESTRA_SIMULATE: {
    purpose: "Run the server in simulation mode.",
    default: "Off.",
  },
  ORCHESTRA_SOCIETY_AUTOSTART: {
    purpose: "Skip the startup hold on council societies, so they start automatically.",
    default: "Councils are held on startup.",
  },
  ORCHESTRA_SOCIETY_ROOT: {
    purpose: "Root directory of the society.",
    default: "\"~/orchestra-society\"",
  },
  ORCHESTRA_SSH_ASKPASS_PORT: {
    purpose: "Port of the ssh-askpass helper.",
  },
  ORCHESTRA_SSH_ASKPASS_TOKEN: {
    purpose: "Token for the ssh-askpass helper.",
  },
  ORCHESTRA_STATE_DIR: {
    purpose: "Override for the state directory.",
    default: "The platform state directory.",
  },
  ORCHESTRA_STORAGE_ACCESS_KEY_ID: {
    purpose: "Access key id for the enterprise storage adapter (S3/R2).",
  },
  ORCHESTRA_STORAGE_ACCOUNT_ID: {
    purpose: "Cloudflare account id for the enterprise R2 storage adapter.",
  },
  ORCHESTRA_STORAGE_ADAPTER: {
    purpose: "Enterprise storage adapter (\"r2\" or \"s3\").",
    default: "None — the adapter throws when unconfigured.",
  },
  ORCHESTRA_STORAGE_BUCKET: {
    purpose: "Bucket for the enterprise storage adapter (S3/R2).",
  },
  ORCHESTRA_STORAGE_REGION: {
    purpose: "Region for the enterprise S3 storage adapter.",
    default: "\"us-east-1\"",
  },
  ORCHESTRA_STORAGE_SECRET_ACCESS_KEY: {
    purpose: "Secret access key for the enterprise storage adapter (S3/R2).",
  },
  ORCHESTRA_STORY: {
    purpose: "TUI storybook story to open (\"1\" opens the index).",
  },
  ORCHESTRA_TEST_HOME: {
    purpose: "Override for the home directory (tests).",
    default: "The real home directory.",
  },
  ORCHESTRA_TEST_ONBOARDING: {
    purpose: "Run the desktop onboarding flow in test mode (\"1\").",
    default: "Off.",
  },
  ORCHESTRA_TEST_PERMISSION_DIAG: {
    purpose: "Tests only: logs which branch the permission check took.",
    default: "Off.",
  },
  ORCHESTRA_TOOL_ROUTER: {
    purpose: "Tool router on/off (\"off\" disables).",
    default: "On.",
  },
  ORCHESTRA_TREE_SITTER_BASH_WASM_PATH: {
    purpose: "Path to the tree-sitter bash wasm file.",
    default: "The bundled wasm.",
  },
  ORCHESTRA_TREE_SITTER_POWERSHELL_WASM_PATH: {
    purpose: "Path to the tree-sitter powershell wasm file.",
    default: "The bundled wasm.",
  },
  ORCHESTRA_TREE_SITTER_WASM_PATH: {
    purpose: "Path to the tree-sitter wasm runtime.",
    default: "The bundled wasm.",
  },
  ORCHESTRA_TUI_CHANNEL: {
    purpose: "Channel override for the TUI.",
    default: "The build channel.",
  },
  ORCHESTRA_UPDATE_URL: {
    purpose: "Update-service URL; without it updates fall back to GitHub releases.",
  },
  ORCHESTRA_VERSION: {
    purpose: "Explicit version for the script build (a non-\"0.0.0-\" value also selects the \"latest\" channel). (Also a build-time define elsewhere — this entry is the script's runtime read.)",
    default: "The version in package.json (at least 1.0.0).",
  },
  ORCHESTRA_VIRTUAL_DISPLAY: {
    purpose: "Virtual display id for desktop capture (for example \":99\").",
    default: "Auto-selected.",
    readIn: "injected-env",
  },
  ORCHESTRA_VZ_DISK: {
    purpose: "Disk image path for Apple Virtualization machines.",
    default: "None (required for Vz machines).",
  },
  ORCHESTRA_VZ_KERNEL: {
    purpose: "Kernel path for Apple Virtualization machines.",
    default: "None (required for Vz machines).",
  },
  ORCHESTRA_ZED_DB: {
    purpose: "Override path to Zed's database file.",
    default: "The standard macOS/Linux Zed database locations.",
  },
  ORCHESTRA_ZEN_MIRROR: {
    purpose: "Mirror Zen provider requests (\"all\" mirrors everything).",
    default: "Off.",
  },
}
