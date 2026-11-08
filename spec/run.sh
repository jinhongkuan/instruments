#!/usr/bin/env bash
# Typecheck and sample-run every Quint spec. Usage: pnpm spec [--max-steps N]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
STEPS="${MAX_STEPS:-30}"
for f in *.qnt; do
  case "$f" in *_test.qnt) continue;; esac
  echo "== typecheck $f"; quint typecheck "$f"
done
echo "== run carry.qnt"
quint run carry.qnt --main carry_spec --invariant allInvariants --max-steps "$STEPS" --max-samples 200 "$@"
for t in *_test.qnt; do
  [ -e "$t" ] || continue
  echo "== test $t"; quint test "$t"
done
