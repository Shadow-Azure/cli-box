#!/usr/bin/env bash
set -euo pipefail

# E2E Skill Installation Test
# Verifies (1) postinstall symlinks binaries but does NOT copy the skill,
# and (2) install.sh installs the skill into the specified target only.
# (The cli-box-skill CLI is covered by node:test in packages/cli-box-skill/test/.)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}➜${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
FAILED=0

if [ "$(uname)" = "Linux" ] && [ -n "${CI:-}" ]; then
  warn "Skipping E2E skill installation tests on Linux CI (macOS frameworks required)"
  exit 0
fi

ensure_platform_binaries() {
  local PKG_BIN="$REPO_ROOT/packages/cli-box-darwin-arm64/bin"
  if [ -f "$PKG_BIN/cli-box" ] && [ -f "$PKG_BIN/cli-box-daemon" ]; then return; fi
  info "Populating platform package bin/ with built binaries..."
  mkdir -p "$PKG_BIN"
  if [ ! -f "$REPO_ROOT/target/release/cli-box" ] && [ ! -f "$REPO_ROOT/target/debug/cli-box" ]; then
    info "  Building with cargo..."; cargo build -p cli-box-cli -p cli-box-daemon >/dev/null 2>&1 || { err "cargo build failed"; exit 1; }
  fi
  if [ -f "$REPO_ROOT/target/release/cli-box" ]; then
    ln -sf "$REPO_ROOT/target/release/cli-box" "$PKG_BIN/cli-box"
    ln -sf "$REPO_ROOT/target/release/cli-box-daemon" "$PKG_BIN/cli-box-daemon"
  else
    ln -sf "$REPO_ROOT/target/debug/cli-box" "$PKG_BIN/cli-box"
    ln -sf "$REPO_ROOT/target/debug/cli-box-daemon" "$PKG_BIN/cli-box-daemon"
  fi
  ok "Platform package binaries linked"
}

test_postinstall() {
  info "Test 1: postinstall (binaries only, no skill copy)"
  local TMP_HOME; TMP_HOME=$(mktemp -d)
  local SKILL_PKG_NM="$REPO_ROOT/packages/cli-box-skill/node_modules"
  local CREATED_NM=0
  cleanup_postinstall() {
    rm -rf "$TMP_HOME"
    if [ "$CREATED_NM" -eq 1 ]; then rm -f "$SKILL_PKG_NM/cli-box-darwin-arm64"; fi
  }
  trap cleanup_postinstall RETURN
  if [ ! -d "$SKILL_PKG_NM/cli-box-darwin-arm64" ]; then
    mkdir -p "$SKILL_PKG_NM"
    ln -s "$REPO_ROOT/packages/cli-box-darwin-arm64" "$SKILL_PKG_NM/cli-box-darwin-arm64"
    CREATED_NM=1
  fi
  if ! HOME="$TMP_HOME" node "$REPO_ROOT/packages/cli-box-skill/postinstall.mjs" 2>&1; then
    err "  postinstall.mjs exited non-zero"; FAILED=1; return
  fi
  [ -L "$TMP_HOME/.cli-box/bin/cli-box" ] && ok "  cli-box symlink created" || { err "  cli-box symlink NOT created"; FAILED=1; }
  [ -L "$TMP_HOME/.cli-box/bin/cli-box-daemon" ] && ok "  cli-box-daemon symlink created" || { err "  cli-box-daemon symlink NOT created"; FAILED=1; }
  if [ -e "$TMP_HOME/.claude/skills/cli-box/SKILL.md" ]; then
    err "  postinstall copied SKILL.md to .claude (should not)"; FAILED=1
  else
    ok "  postinstall did not copy SKILL.md (correct)"
  fi
  info "  Test 1 complete"
}

build_local_tarball() {
  local out="$1"
  local d; d=$(mktemp -d)
  mkdir -p "$d/bin"
  cp "$REPO_ROOT/packages/cli-box-skill/skill/SKILL.md" "$d/"
  if [ ! -f "$REPO_ROOT/target/release/cli-box" ] && [ ! -f "$REPO_ROOT/target/debug/cli-box" ]; then
    cargo build -p cli-box-cli -p cli-box-daemon >/dev/null 2>&1
  fi
  if [ -f "$REPO_ROOT/target/release/cli-box" ]; then
    cp "$REPO_ROOT/target/release/cli-box" "$d/bin/"; cp "$REPO_ROOT/target/release/cli-box-daemon" "$d/bin/"
  else
    cp "$REPO_ROOT/target/debug/cli-box" "$d/bin/"; cp "$REPO_ROOT/target/debug/cli-box-daemon" "$d/bin/"
  fi
  chmod +x "$d/bin/"*
  (cd "$d" && tar czf "$out" .)
  rm -rf "$d"
}

patch_install_sh() {
  local src="$1" dst="$2" tarball="$3"
  cp "$src" "$dst"
  sed -i '' 's/VERSION="${CLI_BOX_VERSION:-latest}"/VERSION="local"/' "$dst"
  sed -i '' '/Fetching latest release version/,/fi/c\
info "Using local version"' "$dst"
  sed -i '' "s|DOWNLOAD_URL=\"https://github.com/\$REPO/releases/download/\$VERSION/cli-box-skill.tar.gz\"|DOWNLOAD_URL=\"file://$tarball\"|" "$dst"
}

test_install_sh() {
  info "Test 2: install.sh <target> (skill into chosen target only)"
  local TMP_HOME; TMP_HOME=$(mktemp -d)
  local TMP_DIR; TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_HOME" "$TMP_DIR"' RETURN
  local tarball="$TMP_DIR/cli-box-skill.tar.gz"
  build_local_tarball "$tarball" || { err "  tarball build failed"; FAILED=1; return; }
  local script="$TMP_DIR/install-local.sh"
  patch_install_sh "$REPO_ROOT/packages/cli-box-skill/skill/install.sh" "$script" "$tarball"
  if ! HOME="$TMP_HOME" bash "$script" claude >/dev/null 2>&1; then
    err "  install.sh claude exited non-zero"; FAILED=1; return
  fi
  [ -f "$TMP_HOME/.cli-box/bin/cli-box" ] && ok "  binaries installed" || { err "  binaries missing"; FAILED=1; }
  [ -f "$TMP_HOME/.claude/skills/cli-box/SKILL.md" ] && ok "  SKILL.md in Claude dir" || { err "  SKILL.md missing in Claude dir"; FAILED=1; }
  [ ! -e "$TMP_HOME/.config/opencode/skills/cli-box" ] && ok "  OpenCode dir untouched" || { err "  OpenCode dir should be untouched"; FAILED=1; }

  info "  Test 2b: install.sh with no target exits 1"
  local rc=0
  HOME="$TMP_HOME" bash "$script" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 1 ]; then err "  expected exit 1, got $rc"; FAILED=1; else ok "  no-target exit 1"; fi
  info "  Test 2 complete"
}

echo ""
echo "=============================================="
echo " E2E Skill Installation Tests"
echo "=============================================="
echo ""
ensure_platform_binaries; echo ""
test_postinstall; echo ""
test_install_sh; echo ""
echo "=============================================="
if [ "$FAILED" -eq 0 ]; then echo -e "${GREEN}All E2E skill installation tests passed!${NC}"; exit 0
else echo -e "${RED}Some E2E skill installation tests failed.${NC}"; exit 1; fi
