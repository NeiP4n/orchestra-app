# Linux paste

`Ctrl+V` in the prompt reads the local desktop clipboard. Native OpenTUI reads
remain first, including image support. If a Linux native read is unavailable,
Orchestra tries the desktop's text helpers without a shell:

- Wayland: `wl-paste` from `wl-clipboard`.
- X11: `xclip`, then `xsel`.

Commands have a time limit and a 4 MiB output limit. Clipboard text and command
stderr are never logged by the fallback. Empty text does not fall through to
another clipboard selection. Cancellation and size-limit failures are not
bypassed. Images still use the native read path.

If no helper works, the prompt shows an error with the install options and the
terminal's `Ctrl+Shift+V`, `Shift+Insert` or middle-click paste options. These
shortcuts are controlled by the terminal; the application cannot force a terminal
to forward an intercepted shortcut. Bracketed paste still uses its existing
input path and needs no clipboard helper.

Over SSH, use the local terminal's paste shortcut. Orchestra does not read the
remote server's unrelated desktop clipboard. The Linux fallback was checked with
injected command results, key-binding tests and a real missing-command test, not
with a live Wayland/X11 desktop or the user's terminal.
