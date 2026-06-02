#!/usr/bin/env sh
set -eu

DISPLAY_VALUE="${DISPLAY:-:99}"
export DISPLAY="$DISPLAY_VALUE"

XVFB_SCREEN="${OMNI_XVFB_SCREEN:-1280x800x24}"
XVFB_LOG="${OMNI_XVFB_LOG:-/tmp/xvfb.log}"

echo "[omni-runtime] Starting Xvfb on DISPLAY=${DISPLAY} screen=${XVFB_SCREEN}"

Xvfb "$DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp >"$XVFB_LOG" 2>&1 &
XVFB_PID="$!"

cleanup() {
  echo "[omni-runtime] Shutting down Xvfb pid=${XVFB_PID}"
  kill "$XVFB_PID" >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

echo "[omni-runtime] Waiting for Xvfb display readiness..."

i=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "[omni-runtime] Xvfb failed to become ready. Log follows:"
    cat "$XVFB_LOG" || true
    exit 1
  fi
  sleep 0.1
done

echo "[omni-runtime] Xvfb is ready. Starting OMNI runtime."

pnpm start
