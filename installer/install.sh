#!/bin/sh
# Installs Orchestra for the current user (Linux, macOS, Git Bash). Needs a prebuilt binary or Rust.
#   sh installer/install.sh              build with cargo and install to ~/.local/bin
#   sh installer/install.sh <binary>     install a prebuilt binary
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
bin="${ORCHESTRA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"

if [ "${1:-}" ]; then
  cp "$1" "$bin/orchestra"
elif command -v cargo >/dev/null 2>&1; then
  (cd "$root" && cargo build --release -p orchestra)
  cp "$root/target/release/orchestra" "$bin/orchestra"
else
  echo "No binary given and Rust is missing. Install Rust (https://rustup.rs) or pass a binary path." >&2
  exit 1
fi
chmod +x "$bin/orchestra"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH:  export PATH=\"$bin:\$PATH\"" ;;
esac
echo "Installed $bin/orchestra. Run: orchestra setup"
