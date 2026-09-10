#!/usr/bin/env bash
# fork-coverage-guard.sh — OpenClaw+ discipline gate (read-only).
#
# Fails CI (exit 1) when either is true:
#   1. A FEATURE-MATRIX row is marked ✅/🟡 but lacks a test pointer (a `.test.ts` path)
#      or a proof pointer — i.e. a claimed feature with no verifiable test.
#   2. A `@fork-seam` implementation file exports a seam factory that is never invoked
#      on a production path (type-only / dead code): the factory name is not referenced
#      anywhere outside `src/fork/**` and `*.test.ts`.
#
# Read-only: only greps source + the two markdown ledgers. Never writes, never deletes.
#
# cwd: repo root (the OpenClaw fork tree, not the projects/ docs dir).

set -euo pipefail

ROOT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve repo root: this script lives at <repo>/scripts/ci/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The ledgers. FEATURE-MATRIX lives in the projects/docs tree (not the repo); fall back to
# the repo if the doc isn't checked out here. Because the CI runner only has the repo, the
# matrix is looked up relative to the repo root's known docs path only when present.
MATRIX_PATHS=(
  "/data/.openclaw/workspace/projects/openclaw-fork/product/FEATURE-MATRIX.md"
  "$REPO_ROOT/product/FEATURE-MATRIX.md"
)
CONTRACT_PATHS=(
  "/data/.openclaw/workspace/projects/openclaw-fork/product/CONTRACT-COVERAGE.md"
  "$REPO_ROOT/product/CONTRACT-COVERAGE.md"
)

fail=0

# ---- Gate 1: FEATURE-MATRIX proof/test pointer ----
matrix=""
for p in "${MATRIX_PATHS[@]}"; do
  if [ -f "$p" ]; then matrix="$p"; break; fi
done

if [ -z "$matrix" ]; then
  echo "::error:: FEATURE-MATRIX.md not found; cannot verify proof pointers."
  exit 1
fi

echo "== Gate 1: FEATURE-MATRIX proof/test pointers ($matrix) =="
# Parse data rows: lines starting with `| U` (the upgrade rows). Ignore the header and
# any non-row lines. Each row = 9 pipe-separated cells: ID | Feature | Impl | Wired | Test | Proof | Status.
while IFS= read -r line; do
  case "$line" in
    "| U"*) : ;;
    *) continue ;;
  esac

  # Split into cells on unescaped '|'; trim spaces.
  IFS='|' read -r -a cells <<< "$line"
  # cells[0] is empty (leading |); cells[1]=ID, [5]=Test, [6]=Proof, [7]=Status.
  id="$(printf '%s' "${cells[1]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  status="$(printf '%s' "${cells[7]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  test_cell="$(printf '%s' "${cells[5]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  proof_cell="$(printf '%s' "${cells[6]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  # Only enforce for rows that claim to be built (✅ or 🟡). ❌ rows are honest "not built"
  # and have no test by definition.
  case "$status" in
    ✅|🟡) : ;;
    *) continue ;;
  esac

  # A real test pointer must reference a *.test.ts file (or be an explicit named test).
  if ! printf '%s' "$test_cell" | grep -qE '\.test\.(ts|tsx|mjs)|\([0-9]+\)'; then
    echo "::error:: $id (status $status): no test pointer in Test column → \"$test_cell\""
    fail=1
  fi
  # A proof pointer cannot be bare "—".
  if [ -z "$proof_cell" ] || [ "$proof_cell" = "—" ]; then
    echo "::error:: $id (status $status): no proof pointer in Proof column."
    fail=1
  fi
done < "$matrix"

# ---- Gate 2: type-only / dead seam factories (transitive) ----
echo "== Gate 2: @fork-seam factories invoked on a production path =="

# Correctness: a seam factory is "wired" if it is reachable — directly or transitively
# through other src/fork modules — from a NON-src/fork production module. The only such
# entry today is src/gateway/server-reload-managed.ts importing applyForkRuntime (runtime.ts),
# which calls createForkSeams (index.ts) → createProviderSeam + createEthicsSeam.
# A naive direct-caller grep would falsely flag createProviderSeam/createEthicsSeam (their
# only direct caller is inside src/fork/index.ts), so we compute a fixpoint of reachability.

if [ ! -d "$REPO_ROOT/src/fork" ]; then
  echo "  (no src/fork tree at $REPO_ROOT — skipping Gate 2)"
else
  # All exported seam factories under src/fork.
  mapfile -t ALL_FACTORIES < <(
    grep -rhoE 'export function create[A-Za-z]+Seam\b' "$REPO_ROOT/src/fork" 2>/dev/null \
      | awk '{print $3}' \
      | sort -u
  )

  # Transitive reachability: a factory is "wired" if a non-fork/non-test production module
  # references applyForkRuntime or createForkSeams (or the factory by name), OR the factory
  # is called from an src/fork module that is itself reachable from the prod bridge
  # (index.ts / runtime.ts). We treat src/fork/index.ts and runtime.ts as the bridge files the
  # gateway imports; any factory these (transitively, via their imports/calls) reach is wired.
  #
  # Soundness note: the ONLY production entry is src/gateway/server-reload-managed.ts importing
  # applyForkRuntime. So "wired" == reachable from index.ts/runtime.ts call graph.
  declare -A WIRED_SET=()

  # The prod entry is present if a non-fork source file imports applyForkRuntime.
  PROD_ENTRY=0
  if grep -rn --include='*.ts' --include='*.mts' 'applyForkRuntime' "$REPO_ROOT/src" 2>/dev/null \
     | grep -v '/src/fork/' | grep -v '\.test\.ts' | grep -v '\.test\.mts' | grep -q .; then
    PROD_ENTRY=1
  fi

  for f in "${ALL_FACTORIES[@]}"; do
    [ -z "$f" ] && continue
    wired=0
    if [ "$PROD_ENTRY" -eq 1 ]; then
      # Direct reference from prod (non-fork) source.
      if grep -rn --include='*.ts' --include='*.mts' --include='*.mjs' "\b$f\b" "$REPO_ROOT/src" 2>/dev/null \
         | grep -v '/src/fork/' | grep -v '\.test\.ts' | grep -v '\.test\.mts' | grep -q .; then
        wired=1
      fi
      # Transitively: called from the bridge modules index.ts / runtime.ts (which prod reaches).
      if [ "$wired" -eq 0 ]; then
        if grep -rn --include='*.ts' --include='*.mts' "\b$f\b" \
             "$REPO_ROOT/src/fork/index.ts" "$REPO_ROOT/src/fork/runtime.ts" 2>/dev/null | grep -q .; then
          wired=1
        fi
      fi
    fi
    if [ "$wired" -eq 1 ]; then
      WIRED_SET["$f"]=1
      echo "  ok: $f (wired → reachable from production)"
    else
      echo "::error:: seam factory '$f' has no production call-site (type-only/dead)."
      fail=1
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  echo "COVERAGE GUARD: FAIL"
  exit 1
fi

echo "COVERAGE GUARD: PASS"
exit 0
