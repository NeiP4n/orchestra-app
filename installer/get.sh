#!/bin/sh
# One-command install for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.sh | sh
# Installs Bun when missing, downloads Orchestra to ~/.local/share/orchestra-app and creates the
# `orchestra-app` command in ~/.local/bin. Running it again updates the checkout.
set -eu
repo="https://github.com/NeiP4n/orchestra-app.git"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/orchestra-app"
bin="${ORCHESTRA_BIN_DIR:-$HOME/.local/bin}"

command -v git >/dev/null 2>&1 || { echo "git is required: install it with your package manager and run this again" >&2; exit 1; }
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -d "$dir/.git" ]; then
  echo "Updating $dir..."
  git -C "$dir" pull --ff-only
else
  echo "Downloading Orchestra to $dir..."
  mkdir -p "$(dirname "$dir")"
  git clone --depth 1 "$repo" "$dir"
fi

echo "Installing dependencies (a few minutes the first time)..."
(cd "$dir" && bun install)

# The interface is Solid JSX, so Bun needs the Solid preload no matter where the command is run from.
mkdir -p "$bin"
cat > "$bin/orchestra-app" <<EOF
#!/bin/sh
exec "$(command -v bun)" --preload="$dir/packages/cli/node_modules/@opentui/solid/scripts/preload.js" "$dir/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "$bin/orchestra-app"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH:  export PATH=\"$bin:\$PATH\"" ;;
esac
echo "Installed. Run: orchestra-app"
