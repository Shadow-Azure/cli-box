#!/usr/bin/env bash
# E2E: compound start command, viewport screenshot, scroll, and scrollback.
# Requires a built release on PATH (cli-box, cli-box-daemon) and Screen Recording
# permission. Skips gracefully when those are unavailable so `sh test.sh` stays green.
set -euo pipefail

# Graceful skip when the toolchain / daemon can't be exercised here.
if ! command -v cli-box >/dev/null 2>&1; then
  echo "SKIP: cli-box not on PATH (needs a release build); skipping compound-start E2E"
  exit 0
fi

MARKER_DIR="$(mktemp -d)"
cleanup() {
  if [ -n "${SID:-}" ]; then cli-box close "$SID" >/dev/null 2>&1 || true; fi
  rm -rf "$MARKER_DIR"
}
trap cleanup EXIT

# 1) Compound command: cd into a temp dir, write a marker file, cat it.
SID=$(cli-box start "cd $MARKER_DIR && printf 'compound-ok\n' > marker.txt && cat marker.txt" \
      | sed -n 's/.*id=\([^,]*\).*/\1/p')
test -n "$SID" || { echo "FAIL: no sandbox id from compound start" >&2; exit 1; }
echo "started sandbox: $SID"

# Give the PTY time to run the compound command.
sleep 3

# 2) scrollback contains the marker text the compound command produced.
TEXT=$(cli-box scrollback --id "$SID" || true)
echo "$TEXT" | grep -q "compound-ok" || { echo "FAIL: compound marker not in scrollback" >&2; exit 1; }
echo "compound command ran (marker found in scrollback)"

# 3) default screenshot + --top screenshot are both PNGs.
cli-box screenshot --id "$SID" -o "$MARKER_DIR/bottom.png" >/dev/null \
  || { echo "FAIL: default screenshot failed" >&2; exit 1; }
cli-box screenshot --id "$SID" --top -o "$MARKER_DIR/top.png" >/dev/null \
  || { echo "FAIL: --top screenshot failed" >&2; exit 1; }
file "$MARKER_DIR/bottom.png" | grep -q "PNG" || { echo "FAIL: bottom.png not PNG" >&2; exit 1; }
file "$MARKER_DIR/top.png"    | grep -q "PNG" || { echo "FAIL: top.png not PNG" >&2; exit 1; }
echo "viewport + top screenshots captured as PNG"

echo "E2E PASS"
