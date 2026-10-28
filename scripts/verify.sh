#!/usr/bin/env bash
# scripts/verify.sh — Matrix-Core 闸门（C0 起；后续阶段逐步加 e2e/guards）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EVIDENCE_DIR="$ROOT/docs/evidence"
PREFIX="${EVIDENCE_PREFIX:-c0}"
mkdir -p "$EVIDENCE_DIR"

run_stage() {
  local stage="$1"; shift
  local out="$EVIDENCE_DIR/${PREFIX}-${stage}.txt"
  echo "▶ [$stage] $*"
  if { echo "──── ${stage} ────"; "$@"; } 2>&1 | tee "$out"; then
    echo "  ✔ ${stage}"
  else
    echo "  ✖ ${stage}（证据：$out）" >&2
    exit 1
  fi
}

run_stage tsc bun x tsc --noEmit
run_stage tests bun test
run_stage docs bun run scripts/docs-check.ts
echo "ALL GREEN"
