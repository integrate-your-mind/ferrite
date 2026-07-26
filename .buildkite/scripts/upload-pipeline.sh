#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="$(buildkite-agent --version)"
[[ "${VERSION}" == "buildkite-agent version 3.127."* ]] || {
  printf 'Ferrite local CI: Buildkite Agent 3.127.x is required, found %s\n' "${VERSION}" >&2
  exit 1
}

extra=()
case "${1:-}" in
  "")
    ;;
  --dry-run)
    [[ "$#" -eq 1 ]] || {
      printf 'usage: %s [--dry-run]\n' "$0" >&2
      exit 64
    }
    extra=(--dry-run --format yaml --agent-access-token local-validation-only)
    ;;
  *)
    printf 'usage: %s [--dry-run]\n' "$0" >&2
    exit 64
    ;;
esac

exec buildkite-agent pipeline upload \
  --reject-secrets \
  "${extra[@]}" \
  .buildkite/pipeline.yml
