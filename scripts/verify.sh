#!/usr/bin/env bash
# scripts/verify.sh - Matrix-Core gate (v0.0.1: tsc -> unit/guards -> e2e -> docs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EVIDENCE_DIR="$ROOT/docs/evidence"
PREFIX="${EVIDENCE_PREFIX:-v0.0.1}"
mkdir -p "$EVIDENCE_DIR"

run_stage() {
  local stage="$1"; shift
  local out="$EVIDENCE_DIR/${PREFIX}-${stage}.txt"
  echo "[stage] $stage: $*"
  if { echo "---- $stage ----"; "$@"; } 2>&1 | tee "$out"; then
    echo "  OK $stage"
  else
    echo "  FAIL $stage (evidence: $out)" >&2
    exit 1
  fi
}

run_stage tsc bun x tsc --noEmit
run_stage unit bun test tests/unit tests/guards
run_stage e2e bun test tests/e2e
run_stage docs bun run scripts/docs-check.ts
echo "ALL GREEN"
