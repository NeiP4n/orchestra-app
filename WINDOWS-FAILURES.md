# Windows unit failures to investigate (from run 42414097296 log /tmp/unit-win3.txt, head e40f6240)
# keybinds test fixed in 511eae49; acp fixed in dead1f1d. Remaining windows-specific:

- web UI assets > sourceAssets resolves nested files when the listing uses Windows backslash separators [17ms]
- web UI assets > sourceAssets skips sourcemaps and fails clearly when the dist is missing [1.68ms]
- server-state.json is created with owner-only permissions [2.80ms]
- probe reports a live server and names its pid [11.99ms]
- probe says no server for a stale lock from a dead pid [10.20ms]
- probe rejects a recycled pid: live pid, wrong startedAt [3.98ms]
- probe reports a live server whose lock was written seconds after process start [2.89ms]
- probe still rejects a pid recycled just after the lock was written [2.75ms]
- probe says no server when there is no lock [1.27ms]
- watchdog exits at once when a server is already running, without starting serve [4.39ms]
- a second watchdog exits at once while the first holds the flock [1.76ms]
- installer dry-run renders a unit with no placeholders, and --check passes it [1.35ms]
- probe finds bun via ORCHESTRA_BUN when PATH has no bun [4.33ms]
- serve starts through ORCHESTRA_BUN when PATH has no bun [2.50ms]
- a broken ORCHESTRA_BUN fails loudly instead of exit 127 restarts [2.61ms]
- generated server password is stored 0600 and retrievable (arch3 №8) [7.00ms]
- deleting a failed service registration stops its owner [20500ms timeout]

Likely Unix-isms: 0600 modes vs Windows ACL, flock, pgrep/process-start-time probing, PATH resolution.
Approach: read test sources + impl, decide per-test whether product needs a Windows path or the
test needs platform-conditional expectations (NOT skipping just for green - document reasoning).
Get exact failure messages: fetch windows unit job log for the current head's run when CI finishes.

# Status at end of run 2026-11-08 ~01:45 +04:
# main = f68b96b1 (5 port-occupancy tests rewritten to fallback-port contract, locally verified)
# Remaining for gate 1: windows set above + verify linux unit green on f68b96b1 in CI.
