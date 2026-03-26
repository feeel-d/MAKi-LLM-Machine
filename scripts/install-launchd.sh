#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$TARGET_DIR" "$ROOT_DIR/.runtime"

for name in com.maki.llama-router com.maki.gateway; do
  sed \
    -e "s#__REPO_ROOT__#$ROOT_DIR#g" \
    -e "s#__HOME__#$HOME#g" \
    "$ROOT_DIR/deploy/macos/$name.plist.template" > "$TARGET_DIR/$name.plist"
  launchctl unload "$TARGET_DIR/$name.plist" >/dev/null 2>&1 || true
  launchctl load "$TARGET_DIR/$name.plist"
done

echo "Installed launchd agents into $TARGET_DIR"
