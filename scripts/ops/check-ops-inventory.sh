#!/usr/bin/env bash
# check-ops-inventory.sh — OPS-SCHED-UNTRACKED-001 ops-inventory drift guard.
#
# Reads docs/ops-scheduled-scripts.md and verifies, on THIS host:
#   1. every inventoried host path still exists            (WARN only — the
#      doc may legitimately describe a foreign host);
#   2. every row marked as SCHEDULED (hermes-cron / crontab / systemd --user)
#      still has its surface entry on this host: the cron id, the crontab
#      line, or the systemd timer is looked up. A scheduled row whose surface
#      no longer mentions it is REAL DRIFT -> stderr warning + exit 1.
#
# Safety: offline (no network), idempotent, read-only. A surface that cannot
# be read here (no crontab, no systemd --user bus, no hermes CLI) produces a
# WARN and is skipped, never failed — a missing surface must not fail a
# foreign-host run.
#
# Exit codes: 0 inventory intact | 1 scheduled-surface drift | 2 doc missing.
#
# Surface-source seams (env; used by tests/ops-inventory.int.test.ts and by
# offline audits of captured schedules — never the live surfaces):
#   OPS_INVENTORY_DOC           inventory doc to check (default: repo doc)
#   OPS_INVENTORY_HERMES_FILE   file holding `hermes cron list` output
#   OPS_INVENTORY_CRONTAB_FILE  file holding `crontab -l` output
#   OPS_INVENTORY_TIMERS_FILE   file holding systemctl --user list-timers
#
# Self-test: `bash scripts/ops/check-ops-inventory.sh --self-test` proves the
# green arm (intact fixture -> exit 0) and the red arm (scheduled surface
# entry removed -> exit 1) entirely in fixture space under a temp dir; it
# never reads or touches the live schedules.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DOC="${OPS_INVENTORY_DOC:-$ROOT/docs/ops-scheduled-scripts.md}"

trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

have() { command -v "$1" >/dev/null 2>&1; }

HERMES_TXT=""  HAVE_HERMES=0
CRON_TXT=""    HAVE_CRON=0
TIMERS_TXT=""  HAVE_TIMERS=0

# Headings under which inventory tables live. Any other '## ' heading (e.g.
# the drift log) ends inventory parsing — its tables have a different shape
# and must not be counted as inventory rows.
INVENTORY_HEADING_RE='^## (Scheduled|Untracked)'

# ---- gather surface snapshots (live commands, or file seams when set) -----
gather_surfaces() {
  local tmp
  tmp="$(mktemp)"
  if [ -n "${OPS_INVENTORY_HERMES_FILE:-}" ] && [ -f "${OPS_INVENTORY_HERMES_FILE}" ]; then
    HERMES_TXT="$(cat "${OPS_INVENTORY_HERMES_FILE}")"; HAVE_HERMES=1
  elif have hermes && hermes cron list >"$tmp" 2>/dev/null; then
    HERMES_TXT="$(cat "$tmp")"; HAVE_HERMES=1
  fi
  if [ -n "${OPS_INVENTORY_CRONTAB_FILE:-}" ] && [ -f "${OPS_INVENTORY_CRONTAB_FILE}" ]; then
    CRON_TXT="$(cat "${OPS_INVENTORY_CRONTAB_FILE}")"; HAVE_CRON=1
  elif have crontab && crontab -l >"$tmp" 2>/dev/null; then
    CRON_TXT="$(cat "$tmp")"; HAVE_CRON=1
  fi
  if [ -n "${OPS_INVENTORY_TIMERS_FILE:-}" ] && [ -f "${OPS_INVENTORY_TIMERS_FILE}" ]; then
    TIMERS_TXT="$(cat "${OPS_INVENTORY_TIMERS_FILE}")"; HAVE_TIMERS=1
  elif have systemctl && systemctl --user list-timers --all --no-pager >"$tmp" 2>/dev/null; then
    TIMERS_TXT="$(cat "$tmp")"; HAVE_TIMERS=1
  fi
  rm -f "$tmp"
}

# ---- core check: sets CHECK_RC, prints per-row findings --------------------
ROWS=0; WARNS=0; DRIFTS=0; CHECK_RC=0

check_row_paths_and_surfaces() {
  local line c0 name hpath kind sched purpose tracked secrets
  local expanded id timer in_inv=0
  while IFS= read -r line; do
    case "$line" in
      '## '*)
        if printf '%s' "$line" | grep -qE "$INVENTORY_HEADING_RE"; then
          in_inv=1
        else
          in_inv=0
        fi
        continue
        ;;
    esac
    [ "$in_inv" -eq 1 ] || continue
    case "$line" in '|'*) ;; *) continue ;; esac
    IFS='|' read -r c0 name hpath kind sched purpose tracked secrets <<< "$line"
    name="$(trim "$name")"
    case "$name" in ''|-*|Script) continue ;; esac
    hpath="$(trim "$hpath")"; kind="$(trim "$kind")"
    ROWS=$((ROWS + 1))

    # (1) host path existence — WARN only (foreign-host inventories are legal)
    if [ -n "$hpath" ]; then
      expanded="${hpath/#\~/$HOME}"
      if [ ! -f "$expanded" ]; then
        echo "WARN: inventoried path missing on this host: $hpath ($name)" >&2
        WARNS=$((WARNS + 1))
      fi
    fi

    # (2) scheduled-surface presence — FAIL on drift
    case "$kind" in
      *hermes-cron*)
        if [ "$HAVE_HERMES" -ne 1 ]; then
          echo "WARN: hermes cron surface unavailable here — schedule check skipped ($name)" >&2
          WARNS=$((WARNS + 1)); continue
        fi
        id="$(printf '%s' "$kind" | grep -oE '[0-9a-f]{12}' | head -1)"
        if [ -n "$id" ]; then
          if ! printf '%s' "$HERMES_TXT" | grep -q -- "$id"; then
            echo "DRIFT: scheduled row '$name': hermes cron id $id no longer listed" >&2
            DRIFTS=$((DRIFTS + 1))
          fi
        elif ! printf '%s' "$HERMES_TXT" | grep -qF -- "$name"; then
          echo "DRIFT: scheduled row '$name': not found in hermes cron list" >&2
          DRIFTS=$((DRIFTS + 1))
        fi
        ;;
      *crontab*)
        if [ "$HAVE_CRON" -ne 1 ]; then
          echo "WARN: crontab surface unavailable here — schedule check skipped ($name)" >&2
          WARNS=$((WARNS + 1)); continue
        fi
        if ! printf '%s' "$CRON_TXT" | grep -qF -- "$name"; then
          echo "DRIFT: scheduled row '$name': no crontab entry on this host" >&2
          DRIFTS=$((DRIFTS + 1))
        fi
        ;;
      *systemd*)
        if [ "$HAVE_TIMERS" -ne 1 ]; then
          echo "WARN: systemd --user surface unavailable here — schedule check skipped ($name)" >&2
          WARNS=$((WARNS + 1)); continue
        fi
        timer="$(printf '%s' "$kind" | grep -oE '[a-zA-Z0-9@._-]+\.timer' | head -1)"
        if [ -z "$timer" ]; then
          echo "WARN: systemd row without a .timer name in inventory: $name" >&2
          WARNS=$((WARNS + 1)); continue
        fi
        if ! printf '%s' "$TIMERS_TXT" | grep -qF -- "$timer"; then
          echo "DRIFT: scheduled row '$name': timer $timer no longer listed" >&2
          DRIFTS=$((DRIFTS + 1))
        fi
        ;;
      *)
        : # helper / unscheduled row — path check only
        ;;
    esac
  done < "$DOC"
}

run_check() {
  ROWS=0; WARNS=0; DRIFTS=0
  # Resolve the doc target HERE, not at script top: self_test re-points
  # OPS_INVENTORY_DOC per call, and env-prefixed function calls must take
  # effect (a top-level resolution would pin the repo doc for every call).
  DOC="${OPS_INVENTORY_DOC:-$ROOT/docs/ops-scheduled-scripts.md}"
  if [ ! -f "$DOC" ]; then
    echo "check-ops-inventory: FATAL inventory doc missing: $DOC" >&2
    CHECK_RC=2
    return 0
  fi
  gather_surfaces
  check_row_paths_and_surfaces
  echo "check-ops-inventory: $ROWS rows | $WARNS path/surface warnings | $DRIFTS scheduled-surface drifts"
  if [ "$DRIFTS" -gt 0 ]; then CHECK_RC=1; else CHECK_RC=0; fi
  return 0
}

# ---- fixture-space self-test (proves both arms; never touches live state) --
self_test() {
  local td rc
  td="$(mktemp -d)"
  local fdoc="$td/doc.md" fscript="$td/watchdog-x.sh" fhermes="$td/hermes.txt"
  {
    printf '%s\n' \
      "## Scheduled fixtures" \
      "" \
      "| Script | Host path | Schedule surface | Schedule | Purpose | Tracked? | Secrets? |" \
      "|---|---|---|---|---|---|---|" \
      "| watchdog-x.sh | $fscript | hermes-cron aabbccddeeff | daily | fixture | no | no |" \
      "| helper-y.sh | $td/helper-y.sh | helper (unscheduled) | — | fixture | no | no |"
  } > "$fdoc"
  : > "$fscript"; : > "$td/helper-y.sh"
  printf '  aabbccddeeff [active]\n    Name:      fixture-watchdog\n' > "$fhermes"

  # The green arm must prove rows were actually CHECKED, not exit 0 vacuously:
  # a fixture that parses to zero rows would otherwise "pass" here and in CI.
  # Call run_check DIRECTLY (a $( ) command substitution would run it in a
  # subshell and CHECK_RC would not propagate), capturing output to a file.
  local out
  OPS_INVENTORY_DOC="$fdoc" OPS_INVENTORY_HERMES_FILE="$fhermes" run_check > "$td/out.txt" 2>&1
  rc=$CHECK_RC
  out="$(cat "$td/out.txt")"
  if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q '2 rows'; then
    echo "SELF-TEST FAIL: intact fixture exited $rc (want 0 with '2 rows'); got: $out"
    rm -rf "$td"; return 1
  fi

  printf '  112233445566 [active]\n    Name:      other\n' > "$fhermes"
  OPS_INVENTORY_DOC="$fdoc" OPS_INVENTORY_HERMES_FILE="$fhermes" run_check > "$td/out.txt" 2>&1
  rc=$CHECK_RC
  out="$(cat "$td/out.txt")"
  if [ "$rc" -ne 1 ] || ! printf '%s' "$out" | grep -q 'aabbccddeeff no longer listed'; then
    echo "SELF-TEST FAIL: drift fixture exited $rc (want 1 naming aabbccddeeff); got: $out"
    rm -rf "$td"; return 1
  fi

  rm -rf "$td"
  echo "SELF-TEST PASS (green arm exit 0, red arm exit 1)"
  return 0
}

# ---- main -------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  if self_test; then exit 0; else exit 1; fi
fi

run_check
exit $CHECK_RC
