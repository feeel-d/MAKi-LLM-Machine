#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"

if [[ "$ROOT_DIR" == *"/Desktop/"* ]] || [[ "$ROOT_DIR" == *"/Documents/"* ]]; then
  echo "참고: 저장소가 Desktop/Documents 아래에 있으면 macOS 보호로 launchd가 스크립트·Node가 프로젝트 파일을 읽지 못해 실패할 수 있습니다."
  echo "      (라우터: Operation not permitted, 게이트웨이: exit 78 등) → ~/Developer 등으로 옮기거나,"
  echo "      시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한에 터미널·node를 추가하거나,"
  echo "      launchd 대신 로그인 후 ./scripts/start-all.sh 를 쓰는 편이 안전합니다."
  echo ""
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node 를 PATH 에서 찾을 수 없습니다. nvm/n 을 쓰는 경우 터미널에서 PATH 가 잡힌 상태로 이 스크립트를 실행하세요."
  exit 1
fi

PATH_FOR_LAUNCHD="${HOME}/.n/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$TARGET_DIR" "$ROOT_DIR/.runtime"

for name in com.maki.llama-router com.maki.gateway; do
  sed \
    -e "s#__REPO_ROOT__#$ROOT_DIR#g" \
    -e "s#__HOME__#$HOME#g" \
    -e "s#__NODE_BIN__#$NODE_BIN#g" \
    -e "s|__PATH_FOR_LAUNCHD__|$PATH_FOR_LAUNCHD|g" \
    "$ROOT_DIR/deploy/macos/$name.plist.template" > "$TARGET_DIR/$name.plist"
  launchctl unload "$TARGET_DIR/$name.plist" >/dev/null 2>&1 || true
  launchctl load "$TARGET_DIR/$name.plist"
done

echo "Installed launchd agents into $TARGET_DIR"
