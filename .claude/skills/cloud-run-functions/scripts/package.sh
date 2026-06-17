#!/usr/bin/env bash
set -euo pipefail

# Package a Cloud Run function for deploy by bundling shared code into its directory.
# Does NOT deploy — that's the user's job.
#
# Usage:
#   ./scripts/package.sh <function-name>           # bundle shared code in
#   ./scripts/package.sh <function-name> --clean    # remove bundled shared code
#
# Examples:
#   ./scripts/package.sh extract
#   ./scripts/package.sh capture-feedback
#   ./scripts/package.sh eval/quality
#   ./scripts/package.sh extract --clean

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
CLOUD_RUN_DIR="${REPO_ROOT}/cloud-run"

# ── Parse arguments ──────────────────────────────────────────────────

FUNCTION=""
CLEAN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --clean) CLEAN=true; shift ;;
    -*)      echo "Unknown option: $1" >&2; exit 1 ;;
    *)       FUNCTION="$1"; shift ;;
  esac
done

if [[ -z "$FUNCTION" ]]; then
  echo "Usage: ./scripts/package.sh <function-name> [--clean]"
  echo ""
  echo "Functions: extract, translate, capture-feedback, eval/quality, eval/drift"
  exit 1
fi

# ── Resolve function directory ────────────────────────────────────────

FUNCTION_DIR="${CLOUD_RUN_DIR}/${FUNCTION}"

if [[ ! -d "$FUNCTION_DIR" ]]; then
  echo "Error: function directory not found: ${FUNCTION_DIR}" >&2
  exit 1
fi

# ── Clean mode ────────────────────────────────────────────────────────

if [[ "$CLEAN" == true ]]; then
  if [[ -d "${FUNCTION_DIR}/shared/" ]]; then
    rm -rf "${FUNCTION_DIR}/shared/"
    echo "Cleaned bundled shared code from ${FUNCTION}/."
  else
    echo "Nothing to clean — ${FUNCTION}/shared/ does not exist."
  fi
  exit 0
fi

# ── Package ───────────────────────────────────────────────────────────

if [[ -d "${FUNCTION_DIR}/shared/" ]]; then
  echo "Warning: ${FUNCTION}/shared/ already exists. Replacing."
  rm -rf "${FUNCTION_DIR}/shared/"
fi

cp -r "${CLOUD_RUN_DIR}/shared/" "${FUNCTION_DIR}/shared/"

# Determine runtime for the summary message
if [[ -f "${FUNCTION_DIR}/index.js" ]]; then
  RUNTIME="Node.js"
elif [[ -f "${FUNCTION_DIR}/main.py" ]]; then
  RUNTIME="Python"
else
  RUNTIME="unknown"
fi

echo "Packaged ${FUNCTION} (${RUNTIME}) with shared code."
echo "Ready to deploy from: ${FUNCTION_DIR}/"
echo ""
echo "To clean up after deploying:"
echo "  ./scripts/package.sh ${FUNCTION} --clean"
