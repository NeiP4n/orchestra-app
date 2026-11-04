# Platform Audit — Forensic Audit V2 (partial)

- The owner's failure was reproduced analytically on the Windows path from his
  screenshots: the blocking card, the "Moved to ..." transcript entries and
  the bare 500 were traced through the TUI session screen, the location
  context and the client sync fan-out to the all-or-nothing failure model
  fixed by F-LOC-1.
- The TUI was not executed in the sandbox (owner prohibition after the
  approval-flood incident); verification is at the data-layer test level.
- Cross-platform, Android/Termux, installation and packaging were not
  inspected in this pass. No claims are made.
