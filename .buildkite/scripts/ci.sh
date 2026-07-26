#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(git rev-parse --show-toplevel)"
readonly REPORT_DIR="${ROOT}/dist/ci"
readonly MODE="${1:-}"

cd "${ROOT}"

fail() {
  printf 'Ferrite local CI: %s\n' "$*" >&2
  exit 1
}

run_gate() {
  local label="$1"
  shift
  local log="${REPORT_DIR}/${label}.log"
  local status

  printf '\n--- %s\n' "${label}"
  set +e
  "$@" 2>&1 | /usr/bin/tee "${log}"
  status="${PIPESTATUS[0]}"
  set -e
  printf '%s\t%s\n' "${label}" "${status}" >> "${REPORT_DIR}/results.tsv"
  return "${status}"
}

preflight() {
  mkdir -p "${REPORT_DIR}"
  : > "${REPORT_DIR}/results.tsv"

  git diff --quiet || fail "tracked worktree changes are not allowed"
  git diff --cached --quiet || fail "staged changes are not allowed"

  local head
  head="$(git rev-parse HEAD)"
  if [[ "${BUILDKITE:-}" == "true" ]]; then
    [[ "${BUILDKITE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] ||
      fail "BUILDKITE_COMMIT must be an exact Git SHA"
    [[ "${head}" == "${BUILDKITE_COMMIT}" ]] ||
      fail "checkout ${head} does not match approved build ${BUILDKITE_COMMIT}"
  fi

  [[ "$(uname -s)" == "Darwin" ]] ||
    fail "the committed local-agent lane is intentionally limited to macOS"
  [[ "$(uname -m)" == "arm64" ]] ||
    fail "the committed local-agent lane is intentionally limited to arm64"
  command -v node >/dev/null || fail "Node.js is unavailable"
  command -v rustc >/dev/null || fail "Rust is unavailable"
  command -v corepack >/dev/null || fail "Corepack is unavailable"
  command -v buildkite-agent >/dev/null || fail "Buildkite Agent is unavailable"

  local node_major pnpm_version rust_version
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 22 )) || fail "Node.js 22 or newer is required"
  pnpm_version="$(corepack pnpm --version)"
  [[ "${pnpm_version}" == "11.7.0" ]] ||
    fail "pnpm 11.7.0 is required, found ${pnpm_version}"
  rust_version="$(rustc --version)"
  [[ "${rust_version}" == rustc\ 1.95.* ]] ||
    fail "Rust 1.95 is required, found ${rust_version}"

  {
    printf 'commit=%s\n' "${head}"
    printf 'tree=%s\n' "$(git rev-parse 'HEAD^{tree}')"
    printf 'timestamp_utc=%s\n' "$(/bin/date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'node=%s\n' "$(node --version)"
    printf 'pnpm=%s\n' "${pnpm_version}"
    printf 'rust=%s\n' "${rust_version}"
    printf 'buildkite_agent=%s\n' "$(buildkite-agent --version)"
    printf 'host_os=%s\n' "$(uname -s)"
    printf 'host_arch=%s\n' "$(uname -m)"
  } > "${REPORT_DIR}/environment.txt"
}

bootstrap() {
  run_gate install corepack pnpm install --frozen-lockfile
}

browser_executable() {
  if [[ -n "${FERRITE_BROWSER_EXECUTABLE:-}" ]]; then
    [[ -x "${FERRITE_BROWSER_EXECUTABLE}" ]] ||
      fail "FERRITE_BROWSER_EXECUTABLE is not executable"
    printf '%s' "${FERRITE_BROWSER_EXECUTABLE}"
    return
  fi

  local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "${chrome}" ]]; then
    printf '%s' "${chrome}"
    return
  fi

  corepack pnpm exec playwright-core install chromium
  local installed
  installed="$(node --input-type=module -e \
    'import { chromium } from "playwright-core"; process.stdout.write(chromium.executablePath())')"
  [[ -x "${installed}" ]] || fail "Playwright Chromium installation is unavailable"
  printf '%s' "${installed}"
}

verify() {
  local browser
  browser="$(browser_executable)"
  run_gate lint corepack pnpm lint
  run_gate typecheck corepack pnpm typecheck
  run_gate build corepack pnpm build
  run_gate test env FERRITE_BROWSER_EXECUTABLE="${browser}" corepack pnpm test
}

packages() {
  local pipeline_token=()
  if [[ "${BUILDKITE:-}" != "true" ]]; then
    pipeline_token=(--agent-access-token local-validation-only)
  fi

  run_gate release-npm corepack pnpm release:verify:npm
  run_gate release-cargo corepack pnpm release:verify:cargo
  run_gate cargo-audit cargo audit --deny warnings
  run_gate website-install npm --prefix website ci
  run_gate website-lint npm --prefix website run lint
  run_gate website-test npm --prefix website test
  run_gate website-production-audit npm --prefix website audit --omit=dev --audit-level=high
  run_gate buildkite-pipeline buildkite-agent pipeline upload \
    --dry-run \
    --format yaml \
    --reject-secrets \
    "${pipeline_token[@]}" \
    .buildkite/pipeline.yml
  run_gate secret-scan gitleaks git --no-banner --redact --log-opts=-1
}

coverage() {
  local rustc_path
  rustc_path="$(rustup which --toolchain stable rustc)"
  run_gate coverage-rust env RUSTC="${rustc_path}" rustup run stable cargo llvm-cov \
    --workspace \
    --all-targets \
    --summary-only \
    -- \
    --test-threads=1
  run_gate coverage-runtime bash -c \
    'cd packages/runtime && exec node --test --experimental-test-coverage test/*.test.mjs'
  run_gate coverage-native bash -c \
    'cd packages/node && exec node --test --experimental-test-coverage test/*.test.mjs'
}

native_current_host() {
  local expected
  expected="$(node --input-type=module -e \
    'import { nativePrebuildPackageName } from "./packages/node/binding.js";
     const name = nativePrebuildPackageName({});
     if (!name) process.exit(1);
     process.stdout.write(name);')"
  run_gate native-package corepack pnpm --filter @ferrite/node prebuild:package
  run_gate native-verify corepack pnpm --filter @ferrite/node prebuild:verify --expect "${expected}"
}

nginx() {
  command -v docker >/dev/null || fail "Docker is required for the nginx proof"
  docker info >/dev/null 2>&1 || fail "Docker is installed but its daemon is unavailable"
  run_gate nginx-stack corepack pnpm test:nginx:stack
}

case "${MODE}" in
  preflight)
    preflight
    ;;
  verify)
    preflight
    bootstrap
    verify
    ;;
  packages)
    preflight
    bootstrap
    packages
    ;;
  coverage)
    preflight
    bootstrap
    coverage
    ;;
  native)
    preflight
    bootstrap
    native_current_host
    ;;
  nginx)
    preflight
    bootstrap
    nginx
    ;;
  all)
    preflight
    bootstrap
    verify
    packages
    coverage
    native_current_host
    nginx
    ;;
  *)
    printf 'usage: %s {preflight|verify|packages|coverage|native|nginx|all}\n' "$0" >&2
    exit 64
    ;;
esac
