#!/usr/bin/env bash
set -euo pipefail

exec buildkite-agent pipeline upload \
  --reject-secrets \
  .buildkite/pipeline.yml
