#!/usr/bin/env bash
#
# teardown-production.sh — emergency takedown of cat-factory's cost-spiraling
# production infrastructure.
#
# WHAT IT KILLS
#   - The `cat-factory-backend` Worker. Deleting the Worker also tears down
#     everything attached to it that can run up a bill if left alive:
#       * the ExecutionContainer container application (Pi runner instances),
#       * the ExecutionWorkflow / GitHubBackfillWorkflow Durable Objects + Workflows,
#       * the */2 * * * * and 0 3 * * * cron triggers.
#   - (Opt-in, --include-pages) the `cat-factory` Cloudflare Pages project.
#
# WHAT IT DELIBERATELY KEEPS
#   - The `cat_factory` D1 database and ALL its data. This script never issues a
#     destructive D1 command. Re-deploying the Worker reattaches to it.
#
# SCOPE / SAFETY
#   - Acts ONLY on resources named `cat-factory*`. The authenticated account also
#     hosts unrelated projects (lifesim, wardebt, scriba, recur, ...); this script
#     names its targets explicitly and never enumerates-and-deletes.
#   - Verifies the logged-in account before doing anything, and refuses unless the
#     account id matches EXPECTED_ACCOUNT_ID (override with --account <id> or the
#     CF_EXPECTED_ACCOUNT env var if you intentionally run it elsewhere).
#   - Interactive by default: prints the plan and makes you type the Worker name.
#     Use --yes for unattended/CI use, --dry-run to preview with zero changes.
#
# USAGE
#   ./teardown-production.sh                 # preview plan, then confirm by typing
#   ./teardown-production.sh --dry-run       # show what would happen, change nothing
#   ./teardown-production.sh --yes           # no prompt (CI / incident response)
#   ./teardown-production.sh --include-pages # also delete the Pages frontend
#   ./teardown-production.sh --account <id>  # allow a different CF account

set -euo pipefail

# ---- configuration ---------------------------------------------------------
WORKER_NAME="cat-factory-backend"
PAGES_PROJECT="cat-factory"
EXPECTED_ACCOUNT_ID="${CF_EXPECTED_ACCOUNT:-fe0047c6e869c8cb875ca425a9c341af}"

# wrangler.toml lives one level up from this script (packages/worker).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/../packages/worker" && pwd)"

# ---- flags -----------------------------------------------------------------
DRY_RUN=false
ASSUME_YES=false
INCLUDE_PAGES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    -y|--yes)         ASSUME_YES=true ;;
    --include-pages)  INCLUDE_PAGES=true ;;
    --account)        EXPECTED_ACCOUNT_ID="${2:?--account needs an id}"; shift ;;
    -h|--help)        sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Prefer a locally-installed wrangler; fall back to npx.
WRANGLER=(npx --no-install wrangler)
command -v wrangler >/dev/null 2>&1 && WRANGLER=(wrangler)

run() {
  if $DRY_RUN; then
    echo "  [dry-run] ${*}"
  else
    echo "  + ${*}"
    "$@"
  fi
}

# ---- 1. confirm we are pointed at the right account ------------------------
echo "==> Verifying Cloudflare authentication..."
WHOAMI="$("${WRANGLER[@]}" whoami 2>&1 || true)"
ACCOUNT_ID="$(printf '%s\n' "$WHOAMI" | grep -oE '[0-9a-f]{32}' | head -1 || true)"

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "ERROR: not logged in to wrangler. Run 'wrangler login' first." >&2
  exit 1
fi
if [[ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "ERROR: logged-in account ($ACCOUNT_ID) != expected ($EXPECTED_ACCOUNT_ID)." >&2
  echo "       Re-auth, or pass --account $ACCOUNT_ID if this is intentional." >&2
  exit 1
fi
echo "    OK — account $ACCOUNT_ID"

# ---- 2. show the plan ------------------------------------------------------
cat <<PLAN

==> Teardown plan ($($DRY_RUN && echo 'DRY RUN — no changes' || echo 'LIVE')):
      DELETE  Worker        $WORKER_NAME
              └─ also removes: ExecutionContainer instances,
                 ExecutionWorkflow + GitHubBackfillWorkflow, cron triggers
$($INCLUDE_PAGES && echo "      DELETE  Pages project $PAGES_PROJECT" || echo "      KEEP    Pages project $PAGES_PROJECT (pass --include-pages to remove)")
      KEEP    D1 database   cat_factory  (data preserved — never touched)

PLAN

# ---- 3. confirm ------------------------------------------------------------
if ! $DRY_RUN && ! $ASSUME_YES; then
  read -r -p "Type the Worker name ('$WORKER_NAME') to proceed: " reply
  if [[ "$reply" != "$WORKER_NAME" ]]; then
    echo "Aborted — input did not match." >&2
    exit 1
  fi
fi

# ---- 4. delete the Worker (kills containers + workflows + crons) -----------
echo "==> Deleting Worker '$WORKER_NAME'..."
if "${WRANGLER[@]}" deployments list --name "$WORKER_NAME" >/dev/null 2>&1; then
  run "${WRANGLER[@]}" delete --name "$WORKER_NAME" --force
else
  echo "    (Worker not found — already gone, nothing to do.)"
fi

# ---- 5. optionally delete the Pages project --------------------------------
if $INCLUDE_PAGES; then
  echo "==> Deleting Pages project '$PAGES_PROJECT'..."
  if "${WRANGLER[@]}" pages project list 2>/dev/null | grep -q "\b$PAGES_PROJECT\b"; then
    run "${WRANGLER[@]}" pages project delete "$PAGES_PROJECT" --yes
  else
    echo "    (Pages project not found — nothing to do.)"
  fi
fi

echo
echo "==> Done. Cost-spiraling infra is down; D1 data is intact."
echo "    To bring production back:  cd packages/worker && wrangler deploy"
