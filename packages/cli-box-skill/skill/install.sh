#!/usr/bin/env bash
set -euo pipefail

# cli-box skill installer
# Downloads binaries from GitHub Release and sets up skill files

REPO="Shadow-Azure/cli-box"
VERSION="${CLI_BOX_VERSION:-latest}"
INSTALL_DIR="$HOME/.cli-box/bin"
SKILL_CLAUDE_DIR="$HOME/.claude/skills/cli-box"
SKILL_OPENCODE_DIR="$HOME/.config/opencode/skills/cli-box"
SKILL_OPENCLAW_DIR="$HOME/.openclaw/skills/cli-box"

info()  { echo "  ➜  $*"; }
ok()    { echo "  ✓  $*"; }
err()   { echo "  ✗  $*" >&2; exit 1; }

echo ""
echo "=============================================="
echo " cli-box — Skill Installer"
echo "=============================================="
echo ""

# Check prerequisites
if ! command -v curl &>/dev/null; then
    err "curl not found — please install curl"
fi

if [[ "$(uname)" != "Darwin" ]]; then
    err "cli-box only supports macOS"
fi

# Determine version
if [ "$VERSION" = "latest" ]; then
    info "Fetching latest release version..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"//' | sed 's/".*//')
    if [ -z "$VERSION" ]; then
        err "Failed to fetch latest version"
    fi
fi
ok "Version: $VERSION"

# Download skill tarball
info "Downloading cli-box-skill.tar.gz..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/cli-box-skill.tar.gz"
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/cli-box-skill.tar.gz"; then
    err "Failed to download from $DOWNLOAD_URL"
fi
ok "Downloaded"

# Extract
info "Extracting..."
tar xzf "$TMPDIR/cli-box-skill.tar.gz" -C "$TMPDIR"

# Install binaries
info "Installing binaries to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$TMPDIR/bin/cli-box" "$INSTALL_DIR/"
cp "$TMPDIR/bin/cli-box-daemon" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/cli-box" "$INSTALL_DIR/cli-box-daemon"
ok "Binaries installed"

# --- Resolve install targets ---
# Precedence: positional args > CLI_BOX_TARGETS env. Accept space- or comma-
# separated values; "all" expands to every harness.
if [ "$#" -gt 0 ]; then
  TARGETS_RAW="$*"
elif [ -n "${CLI_BOX_TARGETS:-}" ]; then
  TARGETS_RAW="$CLI_BOX_TARGETS"
else
  TARGETS_RAW=""
fi

# Normalize to lowercase, comma/space -> newline
TARGETS=$(echo "$TARGETS_RAW" | tr '[:upper:]' '[:lower:]' | tr ',[:space:]' '\n' | grep -v '^$' || true)

if [ -z "$TARGETS" ]; then
  echo ""
  echo "  ✗ No install target given." >&2
  echo "  Usage: bash install.sh <claude|opencode|openclaw|all> [more...]" >&2
  echo "     or: CLI_BOX_TARGETS=claude,opencode bash install.sh" >&2
  exit 1
fi

install_skill_dir() {
  local label="$1" dir="$2"
  info "Installing skill to ${label}..."
  mkdir -p "$dir"
  cp "$TMPDIR/SKILL.md" "$dir/"
  ok "Skill installed to $dir"
}

if echo "$TARGETS" | grep -qx 'all'; then
  TARGETS="$(printf 'claude\nopencode\nopenclaw')"
fi

while IFS= read -r target; do
  case "$target" in
    claude)  install_skill_dir "Claude Code" "$SKILL_CLAUDE_DIR" ;;
    opencode) install_skill_dir "OpenCode"    "$SKILL_OPENCODE_DIR" ;;
    openclaw) install_skill_dir "OpenClaw"    "$SKILL_OPENCLAW_DIR" ;;
    *) err "Unknown target: $target (valid: claude | opencode | openclaw | all)"; exit 1 ;;
  esac
done <<< "$TARGETS"

# Check PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    info "Add to your PATH:"
    echo "  export PATH=\"\$HOME/.cli-box/bin:\$PATH\""
    echo ""
    info "Add to ~/.zshrc or ~/.bashrc for persistence."
fi

# Verify
echo ""
info "Verifying installation..."
if "$INSTALL_DIR/cli-box" --version &>/dev/null; then
    ok "cli-box installed: $($INSTALL_DIR/cli-box --version 2>&1 || echo 'ok')"
else
    ok "cli-box binary installed (version check requires daemon)"
fi

echo ""
echo "=============================================="
echo " Installation complete!"
echo ""
echo " Quick start:"
echo "   cli-box start claude    # Start Claude Code sandbox"
echo "   cli-box start zsh       # Start zsh sandbox"
echo "   cli-box list            # List active sandboxes"
echo ""
echo " Permissions required:"
echo "   System Settings → Privacy & Security → Accessibility"
echo "   System Settings → Privacy & Security → Screen Recording"
echo "=============================================="
echo ""
