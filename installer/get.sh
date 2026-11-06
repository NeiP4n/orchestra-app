#!/bin/sh
# One-command install for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.sh | sh
# Installs Bun when missing, downloads Orchestra to ~/.local/share/orchestra-app and creates the
# `orchestra-app` command in ~/.local/bin. Running it again updates the checkout.
#
# Flags (used by `orchestra upgrade --method curl`, also handy by hand):
#   --version <v>     install that release's bump commit (from releases.json), not main tip
#   --no-modify-path  do not print the "add to PATH" hint
# Without --version the newest non-yanked `latest`-channel release is installed. When the
# registry cannot be read (offline, or before the first release) the installer falls back
# to the main branch, exactly as it did before releases existed.
set -eu
repo="https://github.com/NeiP4n/orchestra-app.git"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/orchestra-app"
bin="${ORCHESTRA_BIN_DIR:-$HOME/.local/bin}"

version=""
no_modify_path=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || { echo "--version needs a value" >&2; exit 1; }
      version="$2"; shift 2 ;;
    --version=*)
      version="${1#--version=}"; shift ;;
    --no-modify-path)
      no_modify_path=1; shift ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is required: install it with your package manager and run this again" >&2; exit 1; }
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Resolve the release commit from the registry (newest first, so the first
# latest-channel entry is the newest release). Empty target means "main tip".
target=""
registry="$(mktemp)"
trap 'rm -f "$registry"' EXIT
if curl -fsSL "https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/releases.json" -o "$registry" 2>/dev/null; then
  target="$(awk -v want="$version" -F'"' '
    {
      for (i = 2; i < NF; i += 4) {
        if ($i == "version") version = $(i+2)
        else if ($i == "commit") commit = $(i+2)
        else if ($i == "channel") channel = $(i+2)
        else if ($i == "yanked" && $(i+1) ~ /true/) yanked = 1
      }
      if (index($0, "}")) {
        if ((want == "" && channel == "latest" && !yanked) || version == want) { print commit; exit }
        version = ""; commit = ""; channel = ""; yanked = 0
      }
    }
  ' "$registry" 2>/dev/null || true)"
fi
if [ -n "$version" ] && [ -z "$target" ]; then
  echo "Release $version is not in releases.json (or the registry could not be read)" >&2
  exit 1
fi

if [ -d "$dir/.git" ]; then
  echo "Updating $dir..."
  if [ -n "$target" ]; then
    git -C "$dir" fetch --quiet origin main
    git -C "$dir" checkout --quiet --detach "$target"
  else
    git -C "$dir" pull --ff-only
  fi
else
  echo "Downloading Orchestra to $dir..."
  mkdir -p "$(dirname "$dir")"
  if [ -n "$target" ]; then
    git clone --quiet "$repo" "$dir"
    git -C "$dir" checkout --quiet --detach "$target"
  else
    git clone --depth 1 "$repo" "$dir"
  fi
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

if [ "$no_modify_path" -eq 0 ]; then
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) echo "Add $bin to your PATH:  export PATH=\"$bin:\$PATH\"" ;;
  esac
fi
echo "Installed. Run: orchestra-app"
