#!/usr/bin/env bash
set -euo pipefail
TASK_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  TASK_NODE_DIR="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [[ -x "$TASK_NODE_DIR/node" ]]; then
    export PATH="$TASK_NODE_DIR:$PATH"
  else
    echo "Установите Node.js 24+ и pnpm 11."
    exit 1
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  TASK_PNPM_DIR="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
  export PATH="$TASK_PNPM_DIR:$PATH"
fi
cd "$TASK_PROJECT_DIR"
exec pnpm dev "$@"
