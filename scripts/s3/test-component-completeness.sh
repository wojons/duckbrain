#!/usr/bin/env bash
# test-component-completeness.sh — every script the unified wrapper invokes must exist
# IN THE REPO, not only in the deployed scripts dir.
#
# Why this exists (S3-GIT-007, 2026-10-03): duckbrain-s3-unified.sh resolves its three
# components as $SCRIPTS_DIR/{native-sync,daily,weekly}.sh. Two of the three lived ONLY in
# ~/.hermes/scripts and were never committed, so the repo's stated role ("the reviewable,
# versioned source of the ops crons") was false for exactly the layer that then stalled and
# wedged the whole backup for 3 days. An unversioned component cannot be reviewed, tested,
# or rolled back.
#
# Hermetic: reads files, runs nothing, touches no S3.
#
# S3-ALERT-002 adds the alert-path invariant: exactly ONE S3 alert
# implementation (s3-alert-gate.sh), wired into the tracked wrapper, with the
# retired deployment-only net audited by fingerprint instead of being
# re-committed (a second net = duplicate alerts for one outage).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_FILE="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_ROOT="$(dirname "$SELF_DIR")"
WRAPPER="$SELF_DIR/duckbrain-s3-unified.sh"
DEPLOYED_DIR="${DUCKBRAIN_S3_SCRIPTS_DIR:-$HOME/.hermes/scripts}"

pass=0; fail=0
ok()   { echo "  PASS: $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $*"; fail=$((fail+1)); }

echo "=== component completeness (S3-GIT-007)"
if [ ! -f "$WRAPPER" ]; then
  bad "wrapper not found at $WRAPPER"; echo; echo "completeness harness: $pass passed, $fail failed"; exit 1
fi

# 1. every component the wrapper resolves must exist in the repo
mapfile -t refs < <(grep -oE '\$SCRIPTS_DIR/[A-Za-z0-9._-]+\.sh' "$WRAPPER" | sed 's|\$SCRIPTS_DIR/||' | sort -u)
if [ "${#refs[@]}" -eq 0 ]; then
  bad "the wrapper references no \$SCRIPTS_DIR/*.sh component (parser drift? update this harness)"
else
  echo "  wrapper resolves ${#refs[@]} component(s): ${refs[*]}"
fi

for c in "${refs[@]:-}"; do
  [ -n "$c" ] || continue
  if [ -f "$SELF_DIR/$c" ]; then
    ok "tracked in repo: $c"
  else
    bad "MISSING from the repo: $c  (the wrapper calls it; it exists only in $DEPLOYED_DIR)"
  fi
done

# 2. every tracked .sh in this dir that the wrapper can call must be executable
for c in "${refs[@]:-}"; do
  [ -n "$c" ] || continue
  f="$SELF_DIR/$c"
  if [ -f "$f" ] && [ ! -x "$f" ]; then
    bad "not executable: $c (the wrapper invokes it directly)"
  fi
done

# 3. inverse check: no *-sync/daily/weekly component exists in the deployed dir that the
#    repo lacks. Catches the drift from the other side (new layer added, never committed).
if [ -d "$DEPLOYED_DIR" ]; then
  for f in "$DEPLOYED_DIR"/duckbrain-s3-*.sh; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"
    case "$b" in
      *.bak-*) continue ;;
      # S3-ALERT-002: the legacy alert net is retired — it is audited by the
      # dedicated S3 alert check below (fingerprint + edit tripwire), not by the
      # generic tracked/untracked rule: re-committing it would resurrect a second
      # alert implementation, which is the drift this guard exists to stop.
      duckbrain-s3-alert.sh) continue ;;
    esac
    if [ -f "$SELF_DIR/$b" ]; then
      ok "deployed+tracked: $b"
    else
      bad "deployed but UNTRACKED: $b  (commit it into scripts/s3/ or document why it is out of scope)"
    fi
  done
fi

# 4. README table must name every component (the docs are the lookup path)
README="$SELF_DIR/README.md"
if [ -f "$README" ]; then
  for c in "${refs[@]:-}"; do
    [ -n "$c" ] || continue
    if grep -q "\`$c\`" "$README"; then
      ok "README lists: $c"
    else
      bad "README table does not list: $c"
    fi
  done
fi

# 5. S3-ALERT-002 — the S3 alert path must be ONE tracked implementation, wired
#    into the tracked wrapper, with no second (deployment-only) alert helper.
#    Why this check exists: the log-tail net was written first and deployed
#    without a repo twin on main; the gate then landed INSIDE the tracked
#    wrapper. Both kept running — two deliveries for one outage — and the ops
#    inventory claimed a scripts/s3/ twin that never existed. The invariant is
#    one implementation, one signal source, one delivery path.
ALERT_IMPL="s3-alert-gate.sh"
RETIRED_NET="duckbrain-s3-alert.sh"
# sha256 of the deployed legacy net as audited 2026-10-20. It is RETIRED: this
# fingerprint is a tripwire so an in-place EDIT of the dead copy fails loudly
# instead of quietly growing a second implementation.
RETIRED_NET_SHA="c22d93c4ff99044be849e66a383f422dde4629410e7a4b162a9f16ae05687015"

echo "=== S3 alert path (S3-ALERT-002)"
mapfile -t alert_impls < <(
  for f in "$SELF_DIR"/*alert*.sh; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in test-*) continue ;; esac
    basename "$f"
  done | sort
)
if [ "${#alert_impls[@]}" -eq 1 ] && [ "${alert_impls[0]}" = "$ALERT_IMPL" ]; then
  ok "exactly one S3 alert implementation in the repo: $ALERT_IMPL"
else
  bad "expected exactly ONE S3 alert implementation ($ALERT_IMPL); found: ${alert_impls[*]:-none} — a second net means duplicate alerts for one outage"
fi

if [ -f "$SELF_DIR/$ALERT_IMPL" ] && [ -x "$SELF_DIR/$ALERT_IMPL" ]; then
  ok "alert implementation is tracked and executable: $ALERT_IMPL"
else
  bad "alert implementation missing or not executable: $ALERT_IMPL"
fi

if grep -Fq "GATE=\"\$SCRIPTS_DIR/$ALERT_IMPL\"" "$WRAPPER" 2>/dev/null &&
   grep -q 'trap call_gate EXIT' "$WRAPPER" 2>/dev/null; then
  ok "wrapper wires the alert gate on every run (EXIT trap)"
else
  bad "wrapper no longer wires $ALERT_IMPL through its EXIT trap — the alert path is not deployed"
fi

# no tracked script may invoke the retired net (invoking it resurrects it).
# Scope: the whole scripts/ tree, not just this dir — a caller could be added
# anywhere under scripts/.
if grep -rIl --include='*.sh' -e "$RETIRED_NET" "$SCRIPT_ROOT" 2>/dev/null |
   grep -vF "$SELF_DIR/$SELF_FILE" | grep -q .; then
  bad "a tracked script still invokes the retired alert net ($RETIRED_NET); alerting must go through $ALERT_IMPL"
else
  ok "no tracked script invokes the retired alert net"
fi

# the DEPLOYED alert implementation must be the tracked one, byte for byte
if [ -f "$DEPLOYED_DIR/$ALERT_IMPL" ]; then
  if cmp -s "$SELF_DIR/$ALERT_IMPL" "$DEPLOYED_DIR/$ALERT_IMPL"; then
    ok "deployed $ALERT_IMPL is byte-identical to the tracked implementation"
  else
    bad "DRIFT: deployed $ALERT_IMPL differs from the tracked copy — host edited without a PR, or the repo change is undeployed"
  fi
else
  ok "deployed dir holds no $ALERT_IMPL — nothing to compare (foreign host)"
fi

# the retired net: absent = fully consolidated; unchanged = known artifact with
# a pending ops decommission; edited = real drift
if [ -f "$DEPLOYED_DIR/$RETIRED_NET" ]; then
  got_sha="$(sha256sum "$DEPLOYED_DIR/$RETIRED_NET" 2>/dev/null | cut -d' ' -f1)"
  if [ "$got_sha" = "$RETIRED_NET_SHA" ]; then
    ok "RETIRED legacy alert net still deployed, unchanged (sha256 ${got_sha:0:16}…) — DECOMMISSION PENDING: docs/ops-scheduled-scripts.md §\"S3 alert path\""
  else
    bad "the RETIRED alert net was EDITED in place (sha256 ${got_sha:-unreadable} != audited $RETIRED_NET_SHA): alert behaviour changes belong in $ALERT_IMPL"
  fi
else
  ok "no deployment-only alert helper: the retired net is gone, $ALERT_IMPL is the deployed alert path"
fi

echo "  -----"
echo "completeness harness: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
