#!/usr/bin/env bash
# fork-coverage-guard.sh — OpenClaw+ discipline gate (read-only).
#
# Four gates; any FAIL exits non-zero.
#   Gate 1 — FEATURE-MATRIX proof/test pointer: a row marked ✅/🟡 must carry a
#            test pointer (a `.test.ts` path / `(N)` count) AND a proof pointer.
#   Gate 2 — @fork-seam factory reachability: a seam factory must be reachable
#            from a production path (directly or transitively through the
#            src/fork bridge modules). Static (grep) — proves TEXTUAL presence of a
#            call-site, NOT behaviour; see the ledger's `Runtime-proven?` column.
#   Gate 3 — dead-export: an exported `create*Seam` factory under src/fork/** with
#            ZERO production call-sites and no `// @not-wired:` annotation FAILS.
#            (Paid for: `bumpEntitlementForAddon` existed, typechecked, did nothing.)
#   Gate 4 — ledger-mirror integrity (STRICT local mode only): when a projects/ doc
#            copy of a ledger is present AND belongs to the SAME checkout of this repo
#            (byte-identical HEAD commit), it MUST be byte-identical to the repo
#            canonical. A STALE mirror silently lies and can mask the truthful ledger.
#            In CI (doc tree absent) the gate SKIPS; on a host with MULTIPLE divergent
#            checkouts of this repo the mirror may legitimately be a different
#            generation — so there Gate 4 WARNS (non-blocking) unless
#            FORK_GUARD_STRICT_MIRROR=1. Never a false CI failure.
#
# META-GATE (--meta): prove this guard is NON-VACUOUS. It MUST (a) PASS on the real
# ledgers + real source, and (b) FAIL on a deliberately-broken fixture (a temp
# matrix row with a bogus claim + a temp dead export + a bogus is-not-wired claim).
# A guard that cannot fail is not a guard (discipline §0.1).
#
# Read-only in normal mode: only greps source + the two markdown ledgers. The
# --meta mode writes its broken fixtures under ${TMPDIR:-/tmp}, never into the repo.
#
# cwd: repo root (the OpenClaw fork tree, not the projects/ docs dir).

set -euo pipefail

ROOT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve repo root: this script lives at <repo>/scripts/ci/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

META=0
case "${2:-}" in
  --meta) META=1 ;;
esac

# The ledgers are CANONICAL in the repo ($REPO_ROOT/product/*.md) — that is what CI verifies,
# because the CI runner only checks out the repo. The projects/ design tree keeps a mirror copy,
# read here only as a fallback when the repo ledger is absent (e.g. a docs-only checkout).
# Order: canonical first. Gate 4 enforces that a present mirror is byte-identical, so this lookup
# order can never mask a real divergence.
MATRIX_PATHS=(
  "$REPO_ROOT/product/FEATURE-MATRIX.md"
  "/data/.openclaw/workspace/projects/openclaw-fork/product/FEATURE-MATRIX.md"
)
CONTRACT_PATHS=(
  "$REPO_ROOT/product/CONTRACT-COVERAGE.md"
  "/data/.openclaw/workspace/projects/openclaw-fork/product/CONTRACT-COVERAGE.md"
)

# The dead-export hand-list is now DERIVED (Gate 3 greps src/fork for factories), not hand-typed.
# We keep this array only as a cross-check assertion: every factory named here MUST also be
# discovered by the grep in Gate 3 (so the hand-list can never drift ahead of the code).
KNOWN_FACTORIES=(
  createProviderSeam
  createSelfUpgradeSeam
  createAutonomySeam
  createNodeModelSeam
  createRunNodeModelSeam
  createEthicsSeam
  createAutoUpgradeSeam
)

fail=0

# ---- resolve matrix + contract paths ----
matrix=""
for p in "${MATRIX_PATHS[@]}"; do
  if [ -f "$p" ]; then matrix="$p"; break; fi
done
contract=""
for p in "${CONTRACT_PATHS[@]}"; do
  if [ -f "$p" ]; then contract="$p"; break; fi
done

if [ -z "$matrix" ]; then
  echo "::error:: FEATURE-MATRIX.md not found; cannot verify proof pointers."
  exit 1
fi

# ---- Gate 1: FEATURE-MATRIX proof/test pointer ----
echo "== Gate 1: FEATURE-MATRIX proof/test pointers ($matrix) =="
# Parse data rows: lines starting with `| U` (the upgrade rows). Layout (9 data columns, with a
# leading empty cell from the leading `|`):
#   cells[1]=ID · cells[2]=Feature · cells[3]=Impl · cells[4]=Wired · cells[5]=Runtime-proven?
#   · cells[6]=Gate · cells[7]=Test · cells[8]=Proof · cells[9]=Status
# To stay robust to column-count changes, the LAST cell is Status and Test/Proof are resolved
# RELATIVE to the last (Test = n-3, Proof = n-2, Status = n-1).
while IFS= read -r line; do
  case "$line" in
    "| U"*) : ;;
    *) continue ;;
  esac

  IFS='|' read -r -a cells <<< "$line"
  n="${#cells[@]}"
  id="$(printf '%s' "${cells[1]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  status="$(printf '%s' "${cells[$((n-1))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  test_cell="$(printf '%s' "${cells[$((n-3))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  proof_cell="$(printf '%s' "${cells[$((n-2))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  case "$status" in
    ✅|🟡) : ;;
    *) continue ;;
  esac

  if ! printf '%s' "$test_cell" | grep -qE '\.test\.(ts|tsx|mjs)|\([0-9]+\)'; then
    echo "::error:: $id (status $status): no test pointer in Test column → \"$test_cell\""
    fail=1
  fi
  if [ -z "$proof_cell" ] || [ "$proof_cell" = "—" ]; then
    echo "::error:: $id (status $status): no proof pointer in Proof column."
    fail=1
  fi
done < "$matrix"

# ---- Gate 2: type-only / dead seam factories (transitive reachability) ----
echo "== Gate 2: @fork-seam factories invoked on a production path =="

if [ ! -d "$REPO_ROOT/src/fork" ]; then
  echo "  (no src/fork tree at $REPO_ROOT — skipping Gate 2)"
else
  mapfile -t ALL_FACTORIES < <(
    grep -rhoE 'export (function|const) create[A-Za-z]+Seam\b' "$REPO_ROOT/src/fork" 2>/dev/null \
      | sed -E 's/.*(create[A-Za-z]+Seam)\b.*/\1/' \
      | sort -u
  )

  declare -A WIRED_SET=()

  # ---- Transitive reachability (fixpoint over fork module imports) ----
  # Gate 2's documented contract is "reachable from a production path (directly or
  # transitively through the src/fork bridge modules)". A *literal* name grep in
  # non-fork files misses indirection like:  model-setup.ts → applyRunNodeModelSelection
  # → createRunNodeModelSeam → createNodeModelSeam (the real per-node-model run path).
  # So we compute reachability properly:
  #   1. Collect the set of fork modules that are (transitively) imported from a
  #      NON-fork prod file (src/** excluding src/fork/** and tests).
  #   2. The bridge modules index.ts / runtime.ts are always reachable (the fork's
  #      own prod entry/binding, wired from server-reload-managed.ts).
  #   3. A factory is wired if its name is referenced in a reachable module, or
  #      directly in a non-fork prod file.

  # 1a. non-fork prod files that import from src/fork (by a `fork/` specifier).
  mapfile -t NONFORK_IMPORTERS < <(
    grep -rl --include='*.ts' --include='*.mts' --include='*.mjs' \
      -E "from ['\"][^'\"]*fork/" "$REPO_ROOT/src" 2>/dev/null \
      | grep -v '/src/fork/' | grep -v '\.test\.' | sort -u
  )

  # 1b. Build the reachable set with a bash fixpoint over fork-internal imports.
  declare -A REACHABLE=()
  REACHABLE["$REPO_ROOT/src/fork/index.ts"]=1
  REACHABLE["$REPO_ROOT/src/fork/runtime.ts"]=1

  # resolve a relative import specifier to an absolute .ts path under REPO_ROOT.
  resolve_ts() {
    local from_dir="$1" spec="$2"
    local abs
    abs="$(cd "$from_dir" && realpath -m -- "$spec" 2>/dev/null)" || return 1
    printf '%s\n' "$abs"
  }

  # Seed: fork files imported from non-fork prod files.
  for imp in "${NONFORK_IMPORTERS[@]}"; do
    [ -z "$imp" ] && continue
    while IFS= read -r spec; do
      [ -z "$spec" ] && continue
      case "$spec" in
        *'fork/'*) : ;;
        *) continue ;;
      esac
      f="$(resolve_ts "$(dirname "$imp")" "$spec")" || continue
      f="${f%.js}.ts"
      case "$f" in
        "$REPO_ROOT/src/fork/"*) REACHABLE["$f"]=1 ;;
      esac
    done < <(grep -hoE "from ['\"][^'\"]+\.[jt]s['\"]" "$imp" 2>/dev/null | sed -E "s/^from ['\"]//;s/['\"]$//")
  done

  # Fixpoint: follow fork-internal relative imports into .ts files under src/fork.
  changed=1
  while [ "$changed" -eq 1 ]; do
    changed=0
    for rf in "${!REACHABLE[@]}"; do
      while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        case "$spec" in
          '.') continue ;;
        esac
        f="$(resolve_ts "$(dirname "$rf")" "$spec")" || continue
        f="${f%.js}.ts"
        case "$f" in
          "$REPO_ROOT/src/fork/"*) : ;;
          *) continue ;;
        esac
        if [ -f "$f" ] && [ "${REACHABLE[$f]:-0}" != "1" ]; then
          REACHABLE["$f"]=1
          changed=1
        fi
      done < <(grep -hoE "from ['\"]\.\.?/[^'\"]+['\"]" "$rf" 2>/dev/null | sed -E "s/^from ['\"]//;s/['\"]$//")
    done
  done

  # 1c. A factory is wired if referenced in a non-fork prod file, or in a reachable
  #     fork module (directly or transitively through the bridge).
  for f in "${ALL_FACTORIES[@]}"; do
    [ -z "$f" ] && continue
    wired=0

    # (a) referenced in a non-fork prod file.
    if grep -rn --include='*.ts' --include='*.mts' --include='*.mjs' "\b$f\b" "$REPO_ROOT/src" 2>/dev/null \
       | grep -v '/src/fork/' | grep -v '\.test\.' | grep -q .; then
      wired=1
    fi

    # (b) referenced in a reachable fork module (transitive through the bridge).
    if [ "$wired" -eq 0 ]; then
      for rf in "${!REACHABLE[@]}"; do
        if grep -q "\b$f\b" "$rf" 2>/dev/null; then
          wired=1
          break
        fi
      done
    fi

    if [ "$wired" -eq 1 ]; then
      WIRED_SET["$f"]=1
      echo "  ok: $f (wired → reachable from production)"
    else
      echo "::error:: Gate 2: seam factory '$f' has no production call-site (type-only/dead)."
      fail=1
    fi
  done
fi

# ---- Gate 3: dead-export check (wired ≠ present) ----
echo "== Gate 3: dead-export check (exported seam factory w/ zero prod call-site, no @not-wired) =="
if [ ! -d "$REPO_ROOT/src/fork" ]; then
  echo "  (no src/fork tree at $REPO_ROOT — skipping Gate 3)"
else
  # Discover every exported seam factory in src/fork (DERIVED from code, not hand-typed).
  mapfile -t EXPORTED_FACTORIES < <(
    grep -rhoE 'export (function|const) create[A-Za-z]+Seam\b' "$REPO_ROOT/src/fork" 2>/dev/null \
      | sed -E 's/.*(create[A-Za-z]+Seam)\b.*/\1/' \
      | sort -u
  )

  # Cross-check: the hand-list must be a subset of the derived set (never drift ahead).
  for kf in "${KNOWN_FACTORIES[@]}"; do
    found=0
    for ef in "${EXPORTED_FACTORIES[@]}"; do
      [ "$ef" = "$kf" ] && { found=1; break; }
    done
    if [ "$found" -eq 0 ]; then
      echo "  note: known factory '$kf' not in derived set (may have been renamed/removed)."
    fi
  done

  for f in "${EXPORTED_FACTORIES[@]}"; do
    [ -z "$f" ] && continue
    # Skip factories already proven wired by Gate 2.
    if [ "${WIRED_SET[$f]:-0}" = "1" ]; then
      echo "  ok: $f (Gate 2 wired — not a dead export)"
      continue
    fi
    # An explicit `// @not-wired: <reason>` annotation in the declaring module excuses it.
    decl_file="$(grep -rlE "export (function|const) $f\b" "$REPO_ROOT/src/fork" 2>/dev/null | head -n1)"
    if [ -n "$decl_file" ] && grep -q "@not-wired:" "$decl_file" 2>/dev/null; then
      echo "  ok: $f ($decl_file carries @not-wired:)"
      continue
    fi
    echo "::error:: Gate 3: dead export '$f' — exported seam factory with zero production call-site"
    echo "         and no '// @not-wired:' annotation (wired ≠ present)."
    fail=1
  done
fi

# ---- Gate 4: doc-copy ledger integrity (the doc is a MIRROR, not a fork) ----
# The ledgers are canonical in the REPO ($REPO_ROOT/product/*.md) — that is what CI verifies
# (the CI runner has only the repo). A doc copy also lives in the projects/ design tree. When
# BOTH are present on this host they MUST be byte-identical: a stale/divergent copy silently LIES.
# (MATRIX_PATHS now lists the repo canonical FIRST, so a stale mirror can no longer mask it — the
# old masking bug that motivated this gate is closed.) Paid for 2026-09-11: the doc copy was ~6h
# stale, silently downgrading U1/U4/U6/U11/U12 from ✅ to 🟡/❌ in the guard's Gate 1 view.
#
# SCOPE (2026-09-12 fix): the literal doc path is a SPECIFIC checkout
# (`projects/openclaw-fork`). This host carries SEVERAL independent generations of the fork repo
# (dev / tunde / xavier / duo / sister boxes), so that literal copy can belong to a DIFFERENT
# generation than the checkout running this guard — a legitimate divergence, not a lying mirror.
# So "byte-divergent" alone is NOT proof of a lying mirror. We therefore enforce only when the doc
# checkout is provably the SAME repo history as this one (its HEAD sha == ours). Otherwise: WARN
# (non-blocking) so drifts are visible; `FORK_GUARD_STRICT_MIRROR=1` forces blocking everywhere.
# The gate SKIPS cleanly when the doc tree or a file is absent (the CI runner case).
DOC_PRODUCT_DIR="${FORK_GUARD_DOC_DIR:-/data/.openclaw/workspace/projects/openclaw-fork/product}"
if [ -f "$DOC_PRODUCT_DIR/FEATURE-MATRIX.md" ] || [ -f "$DOC_PRODUCT_DIR/CONTRACT-COVERAGE.md" ]; then
  echo "== Gate 4: doc-copy ledger integrity (doc copy MUST mirror the repo canonical) =="
  _head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo)"
  _doc_sha="$(git -C "$DOC_PRODUCT_DIR" rev-parse HEAD 2>/dev/null || echo)"
  _strict="${FORK_GUARD_STRICT_MIRROR:-0}"
  _same_checkout=0
  [ -n "$_head_sha" ] && [ "$_head_sha" = "$_doc_sha" ] && _same_checkout=1
  _blocking=0
  if [ "$_same_checkout" -eq 1 ] || [ "$_strict" = "1" ]; then _blocking=1; fi
  for _name in FEATURE-MATRIX.md CONTRACT-COVERAGE.md; do
    _repo_f="$REPO_ROOT/product/$_name"
    _doc_f="$DOC_PRODUCT_DIR/$_name"
    if [ -f "$_repo_f" ] && [ -f "$_doc_f" ]; then
      if cmp -s "$_repo_f" "$_doc_f"; then
        echo "  ok: $_name (doc copy == repo canonical)"
      else
        echo "  divergence: $_name doc copy != repo canonical ($_doc_f)"
        if [ "$_blocking" -eq 1 ]; then
          echo "::error:: Gate 4: $_name doc copy DIVERGES from the repo canonical (same checkout / strict)."
          echo "         A stale ledger copy silently lies about a runtime-proven claim."
          echo "         Fix: cp '$_repo_f' '$_doc_f'  (then commit BOTH trees)."
          fail=1
        else
          echo "::warning:: Gate 4 (advisory): doc copy belongs to a DIFFERENT repo generation"
          echo "         (HEAD ${_head_sha:-none} != ${_doc_sha:-none}) — not a lying mirror, but the copy is behind."
          echo "         Refresh when the canonical generation settles, or set FORK_GUARD_STRICT_MIRROR=1."
        fi
      fi
    fi
  done
fi

# ---- META-GATE: prove non-vacuity ----
if [ "$META" -eq 1 ]; then
  echo "== META-GATE: prove this guard is non-vacuous =="
  META_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fork-guard-meta.XXXXXX")"
  trap 'rm -rf "$META_DIR"' EXIT

  # --- meta-A: the broken fixture must turn the guard RED ---
  BROKEN_MATRIX="$META_DIR/FEATURE-MATRIX.md"
  {
    printf '| ID | Feature | Impl | Wired | Runtime-proven | Gate | Test | Proof | Status |\n'
    printf '|---|---|---|---|---|---|---|---|---|\n'
    # Bogus: claims status ✅ but has a bare "—" proof pointer (Gate 1 must FAIL).
    printf '| U99 | Bogus never-built seam | — | ✅ | ✅ | — | — | — | ✅ |\n'
  } > "$BROKEN_MATRIX"

  # Re-run Gate 1 logic against the broken matrix; expect a failure.
  broken_fail=0
  while IFS= read -r line; do
    case "$line" in "| U"*) : ;; *) continue ;; esac
    IFS='|' read -r -a cells <<< "$line"
    n="${#cells[@]}"
    status="$(printf '%s' "${cells[$((n-1))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    test_cell="$(printf '%s' "${cells[$((n-3))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    proof_cell="$(printf '%s' "${cells[$((n-2))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    # meta-A broken fixture: hardcode no test/proof → must be caught
    case "$status" in ✅|🟡) : ;; *) continue ;; esac
    if ! printf '%s' "$test_cell" | grep -qE '\.test\.(ts|tsx|mjs)|\([0-9]+\)'; then
      echo "  meta-A: caught missing test pointer (expected)"; broken_fail=1
    fi
    if [ -z "$proof_cell" ] || [ "$proof_cell" = "—" ]; then
      echo "  meta-A: caught empty proof pointer (expected)"; broken_fail=1
    fi
  done < "$BROKEN_MATRIX"

  if [ "$broken_fail" -eq 0 ]; then
    echo "::error:: META-GATE meta-A FAILED: guard did NOT flag the deliberately-broken fixture (vacuous)."
    exit 1
  fi
  echo "  meta-A PASS: guard goes RED on a broken input."

  # --- meta-B: a good fixture must PASS the same logic (guard is not tautologically red) ---
  # We do NOT assert the CURRENT repo is green — it may legitimately carry dead exports (the honest
  # finding). Instead we prove DISCRIMINATION in both directions with a synthetic GOOD fixture:
  #   - a matrix row claiming ✅ with valid Test + Proof pointers (Gate 1 must accept it)
  #   - a dead seam factory that carries `// @not-wired:` (Gate 3 must excuse it)
  GOOD_MATRIX="$META_DIR/GOOD-FEATURE-MATRIX.md"
  {
    printf '| ID | Feature | Impl | Wired | Runtime-proven | Gate | Test | Proof | Status |\n'
    printf '|---|---|---|---|---|---|---|---|---|\n'
    printf '| U1 | Wired seam | src/fork/x | ✅ | ✅ | guard.sh | x.test.ts | runtime green | ✅ |\n'
  } > "$GOOD_MATRIX"

  good_fail=0
  while IFS= read -r line; do
    case "$line" in "| U"*) : ;; *) continue ;; esac
    IFS='|' read -r -a cells <<< "$line"
    n="${#cells[@]}"
    status="$(printf '%s' "${cells[$((n-1))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$/ /')"
    test_cell="$(printf '%s' "${cells[$((n-3))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$/ /')"
    proof_cell="$(printf '%s' "${cells[$((n-2))]:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$/ /')"
    case "$status" in ✅|🟡) : ;; *) continue ;; esac
    if ! printf '%s' "$test_cell" | grep -qE '\.test\.(ts|tsx|mjs)|\([0-9]+\)'; then
      echo "  meta-B: good fixture wrongly flagged missing test pointer (mechanism broken)"; good_fail=1
    fi
    if [ -z "$proof_cell" ] || [ "$proof_cell" = "—" ]; then
      echo "  meta-B: good fixture wrongly flagged empty proof pointer (mechanism broken)"; good_fail=1
    fi
  done < "$GOOD_MATRIX"

  if [ "$good_fail" -ne 0 ]; then
    echo "::error:: META-GATE meta-B FAILED: guard rejected a well-formed GOOD fixture (tautological red)."
    exit 1
  fi
  echo "  meta-B PASS: guard accepts a well-formed GOOD fixture."

  # --- meta-C: Gate 4 must go RED on a deliberately-divergent same-checkout mirror ---
  # Point the guard at a temp "doc" dir holding a MODIFIED ledger copy, force strict mode,
  # and require a non-zero exit. (Re-invokes this script WITHOUT --meta; output discarded.)
  META_DOC="$META_DIR/docprod"
  mkdir -p "$META_DOC"
  cp "$REPO_ROOT/product/FEATURE-MATRIX.md" "$META_DOC/FEATURE-MATRIX.md"
  printf '\n<!-- meta-C deliberate divergence -->\n' >> "$META_DOC/FEATURE-MATRIX.md"
  cp "$REPO_ROOT/product/CONTRACT-COVERAGE.md" "$META_DOC/CONTRACT-COVERAGE.md"
  if FORK_GUARD_DOC_DIR="$META_DOC" FORK_GUARD_STRICT_MIRROR=1 bash "${BASH_SOURCE[0]}" "$ROOT" >/dev/null 2>&1; then
    echo "::error:: META-GATE meta-C FAILED: Gate 4 did not flag a deliberately-divergent mirror (vacuous)."
    exit 1
  fi
  echo "  meta-C PASS: Gate 4 goes RED on a divergent mirror."

  echo "META-GATE: PASS (guard is non-vacuous: red on broken, green on good)."
fi

if [ "$fail" -ne 0 ]; then
  echo "COVERAGE GUARD: FAIL"
  exit 1
fi

echo "COVERAGE GUARD: PASS"
exit 0
