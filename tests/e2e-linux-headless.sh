#!/usr/bin/env bash
# Headless E2E (Linux): start -> screenshot (--top) -> scrollback, no Electron.
# Requires built cli-box + cli-box-daemon on PATH and a renderable font
# (CLIBOX_FONT env, or a system CJK/mono font found by HeadlessTerminal::load_font).
set -euo pipefail

MARKER_DIR="$(mktemp -d)"
SID=""
cleanup() {
  if [ -n "$SID" ]; then cli-box close "$SID" >/dev/null 2>&1 || true; fi
  rm -rf "$MARKER_DIR"
}
trap cleanup EXIT

# `printf` is a single non-compound command -> no shell wrap, no zsh needed.
SID=$(cli-box start printf -- headless-ok 2>&1 | sed -n 's/.*id=\([^,]*\).*/\1/p')
test -n "$SID" || { echo "FAIL: no sandbox id from start" >&2; exit 1; }
echo "started sandbox: $SID"

# Give the PTY + reader thread time to render the command output.
sleep 2

TEXT=$(cli-box scrollback --id "$SID" || true)
echo "$TEXT" | grep -q "headless-ok" \
  || { echo "FAIL: marker not in scrollback" >&2; exit 1; }
echo "scrollback OK (marker found)"

cli-box screenshot --id "$SID" -o "$MARKER_DIR/bottom.png" >/dev/null \
  || { echo "FAIL: default screenshot" >&2; exit 1; }
cli-box screenshot --id "$SID" --top -o "$MARKER_DIR/top.png" >/dev/null \
  || { echo "FAIL: --top screenshot" >&2; exit 1; }
file "$MARKER_DIR/bottom.png" | grep -q "PNG" \
  || { echo "FAIL: bottom.png not PNG" >&2; exit 1; }
file "$MARKER_DIR/top.png" | grep -q "PNG" \
  || { echo "FAIL: top.png not PNG" >&2; exit 1; }
echo "screenshots captured as PNG"

echo "E2E PASS (headless)"
