#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT
REPORT_DIR="${FERRITE_CI_REPORT_DIR:-${ROOT}/dist/ci}"
readonly REPORT_DIR
MODE="${1:-}"
readonly MODE
MIN_FREE_KIB=20971520
readonly MIN_FREE_KIB
COVERAGE_RUST_LINES_FLOOR="90.00"
COVERAGE_RUNTIME_LINES_FLOOR="80.00"
COVERAGE_NATIVE_LINES_FLOOR="78.00"
TEE_BIN="${TEE_BIN:-/usr/bin/tee}"

# Keep clean local-agent jobs reproducible and bound Rust's generated output.
export CARGO_BUILD_JOBS=1
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off

cd "${ROOT}"

fail() {
  printf 'Ferrite local CI: %s\n' "$*" >&2
  exit 1
}

run_gate() {
  local label="$1"
  shift
  local log="${REPORT_DIR}/${label}.log"
  local child_status tee_status status integrity_status
  local start_commit start_tree start_lock start_status
  local end_commit end_tree end_lock end_status
  local end_commit_status end_tree_status end_lock_status end_worktree_status

  start_commit="$(git rev-parse HEAD)"
  start_tree="$(git rev-parse 'HEAD^{tree}')"
  start_lock="$(cargo_lock_sha)"
  start_status="$(git status --porcelain=v1 --untracked-files=all)"
  {
    printf 'start_commit=%s\n' "${start_commit}"
    printf 'start_tree=%s\n' "${start_tree}"
    printf 'start_cargo_lock_sha=%s\n' "${start_lock}"
    printf 'start_status=%s\n' "${start_status}"
  } > "${REPORT_DIR}/${label}.source"

  printf '\n--- %s\n' "${label}"
  set +e
  "$@" >"${log}" 2>&1
  child_status="$?"
  "${TEE_BIN}" -a /dev/null < "${log}"
  tee_status="$?"
  set -e

  set +e
  end_commit="$(git rev-parse HEAD 2>/dev/null)"
  end_commit_status="$?"
  end_tree="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)"
  end_tree_status="$?"
  end_lock="$(cargo_lock_sha 2>/dev/null)"
  end_lock_status="$?"
  end_status="$(git status --porcelain=v1 --untracked-files=all 2>/dev/null)"
  end_worktree_status="$?"
  set -e

  integrity_status=0
  (( end_commit_status == 0 )) || integrity_status=1
  (( end_tree_status == 0 )) || integrity_status=1
  (( end_lock_status == 0 )) || integrity_status=1
  (( end_worktree_status == 0 )) || integrity_status=1
  [[ -n "${end_commit}" && "${start_commit}" == "${end_commit}" ]] || integrity_status=1
  [[ -n "${end_tree}" && "${start_tree}" == "${end_tree}" ]] || integrity_status=1
  [[ -n "${end_lock}" && "${start_lock}" == "${end_lock}" ]] || integrity_status=1
  [[ -z "${end_status}" ]] || integrity_status=1

  if (( child_status != 0 )); then
    status="${child_status}"
  elif (( tee_status != 0 )); then
    status="${tee_status}"
  else
    status="${integrity_status}"
  fi
  {
    printf 'end_commit=%s\n' "${end_commit}"
    printf 'end_tree=%s\n' "${end_tree}"
    printf 'end_cargo_lock_sha=%s\n' "${end_lock}"
    printf 'end_status=%s\n' "${end_status}"
    printf 'child_status=%s\n' "${child_status}"
    printf 'tee_status=%s\n' "${tee_status}"
    printf 'integrity_status=%s\n' "${integrity_status}"
  } >> "${REPORT_DIR}/${label}.source"
  printf '%s\t%s\n' "${label}" "${status}" >> "${REPORT_DIR}/results.tsv"
  return "${status}"
}

cargo_lock_sha() {
  [[ -f "${ROOT}/Cargo.lock" ]] || fail "Cargo.lock is required"
  /usr/bin/shasum -a 256 "${ROOT}/Cargo.lock" | /usr/bin/awk '{ print $1 }'
}

coverage_percent() {
  local kind="$1"
  local log="$2"
  case "${kind}" in
    rust)
      /usr/bin/awk '
        /^TOTAL[[:space:]]/ {
          value = ""
          for (i = 1; i <= NF; i++) {
            if ($i ~ /^[0-9]+([.][0-9]+)?%$/) value = $i
          }
        }
        END {
          if (value == "") exit 1
          sub(/%$/, "", value)
          print value
        }
      ' "${log}"
      ;;
    js)
      /usr/bin/awk '
        index($0, "|") {
          split($0, fields, "|")
          label = fields[1]
          if (label !~ /all files[[:space:]]*$/) next
          sub(/all files[[:space:]]*$/, "", label)
          if (label ~ /[[:alnum:]]/) next
          value = fields[2]
          gsub(/[[:space:]%]/, "", value)
        }
        END {
          if (value !~ /^[0-9]+([.][0-9]+)?$/) exit 1
          print value
        }
      ' "${log}"
      ;;
    *)
      fail "unknown coverage report kind: ${kind}"
      ;;
  esac
}

check_coverage_floor() {
  local kind="$1"
  local log="$2"
  local floor="$3"
  local actual
  [[ -s "${log}" ]] || fail "${kind} coverage report is empty"
  actual="$(coverage_percent "${kind}" "${log}")" ||
    fail "${kind} coverage report is missing a valid lines percentage"
  /usr/bin/awk -v actual="${actual}" -v floor="${floor}" \
    'BEGIN { if (actual + 0 < floor + 0) exit 1 }' ||
    fail "${kind} coverage ${actual}% is below the ${floor}% lines floor"
  printf '%s_lines_coverage=%s\n%s_lines_floor=%s\n' \
    "${kind}" "${actual}" "${kind}" "${floor}" >> "${REPORT_DIR}/coverage-results.tsv"
}

preflight() {
  local available_kib
  available_kib="$(/bin/df -Pk "${ROOT}" | /usr/bin/awk 'NR == 2 { print $4 }')"
  [[ "${available_kib}" =~ ^[0-9]+$ ]] ||
    fail "could not determine available storage for ${ROOT}"
  (( available_kib >= MIN_FREE_KIB )) ||
    fail "storage admission requires at least ${MIN_FREE_KIB} KiB free; found ${available_kib} KiB"

  mkdir -p "${REPORT_DIR}"
  : > "${REPORT_DIR}/results.tsv"

  [[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] ||
    fail "a clean worktree, including untracked files, is required"

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
  command -v pnpm >/dev/null || fail "pnpm is unavailable"
  command -v rustup >/dev/null || fail "rustup is unavailable"
  command -v rustc >/dev/null || fail "Rust is unavailable"
  command -v cargo-audit >/dev/null || fail "cargo-audit is unavailable"
  command -v cargo-llvm-cov >/dev/null || fail "cargo-llvm-cov is unavailable"
  command -v buildkite-agent >/dev/null || fail "Buildkite Agent is unavailable"

  local buildkite_version node_major pnpm_version rust_version
  buildkite_version="$(buildkite-agent --version)"
  [[ "${buildkite_version}" == "buildkite-agent version 3.127."* ]] ||
    fail "Buildkite Agent 3.127.x is required, found ${buildkite_version}"
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 22 )) || fail "Node.js 22 or newer is required"
  pnpm_version="$(pnpm --version)"
  [[ "${pnpm_version}" == "11.7.0" ]] ||
    fail "pnpm 11.7.0 is required, found ${pnpm_version}"
  rust_version="$(rustc --version)"
  [[ "${rust_version}" == rustc\ 1.95.* ]] ||
    fail "Rust 1.95 is required, found ${rust_version}"
  rustup target list --toolchain stable --installed |
    /usr/bin/grep -qx 'wasm32-unknown-unknown' ||
    fail "Rust stable target wasm32-unknown-unknown is required"

  {
    printf 'commit=%s\n' "${head}"
    printf 'tree=%s\n' "$(git rev-parse 'HEAD^{tree}')"
    printf 'cargo_lock_sha=%s\n' "$(cargo_lock_sha)"
    printf 'timestamp_utc=%s\n' "$(/bin/date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'node=%s\n' "$(node --version)"
    printf 'pnpm=%s\n' "${pnpm_version}"
    printf 'rust=%s\n' "${rust_version}"
    printf 'buildkite_agent=%s\n' "${buildkite_version}"
    printf 'host_os=%s\n' "$(uname -s)"
    printf 'host_arch=%s\n' "$(uname -m)"
    printf 'cargo_build_jobs=%s\n' "${CARGO_BUILD_JOBS}"
    printf 'cargo_incremental=%s\n' "${CARGO_INCREMENTAL}"
    printf 'cargo_profile_dev_debug=%s\n' "${CARGO_PROFILE_DEV_DEBUG}"
    printf 'cargo_profile_dev_split_debuginfo=%s\n' \
      "${CARGO_PROFILE_DEV_SPLIT_DEBUGINFO}"
    printf 'storage_available_kib=%s\n' "${available_kib}"
    printf 'storage_minimum_kib=%s\n' "${MIN_FREE_KIB}"
  } > "${REPORT_DIR}/environment.txt"
}

bootstrap() {
  run_gate install pnpm install --frozen-lockfile
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

  pnpm exec playwright-core install chromium
  local installed
  installed="$(node --input-type=module -e \
    'import { chromium } from "playwright-core"; process.stdout.write(chromium.executablePath())')"
  [[ -x "${installed}" ]] || fail "Playwright Chromium installation is unavailable"
  printf '%s' "${installed}"
}

verify() {
  local browser
  browser="$(browser_executable)"
  run_gate lint pnpm lint
  run_gate typecheck pnpm typecheck
  run_gate build pnpm build
  run_gate test env FERRITE_BROWSER_EXECUTABLE="${browser}" pnpm test
}

packages() {
  run_gate release-npm pnpm release:verify:npm
  run_gate release-cargo pnpm release:verify:cargo
  run_gate cargo-audit cargo audit --deny warnings
  run_gate website-install npm --prefix website ci
  run_gate website-lint npm --prefix website run lint
  run_gate website-typecheck npm --prefix website run typecheck
  run_gate website-test npm --prefix website test
  run_gate website-production-audit npm --prefix website audit --omit=dev --audit-level=high
  run_gate buildkite-pipeline ./.buildkite/scripts/upload-pipeline.sh --dry-run
  run_gate secret-scan gitleaks git --no-banner --redact
}

coverage_rust() {
  # Cargo coverage exercises the real client bundler, which resolves the
  # workspace runtime package through its built protocol exports.
  run_gate coverage-rust-prerequisites pnpm --filter @ferrite/runtime build
  run_gate coverage-rust rustup run stable cargo llvm-cov --locked \
    --workspace \
    --all-targets \
    --summary-only \
    -- \
    --test-threads=1
  check_coverage_floor rust "${REPORT_DIR}/coverage-rust.log" "${COVERAGE_RUST_LINES_FLOOR}"
}

coverage_js() {
  # Clean jobs cannot inherit ignored runtime/native artifacts from verify.
  run_gate coverage-runtime-prerequisites pnpm --filter @ferrite/runtime build
  run_gate coverage-native-prerequisites pnpm --filter @ferrite/node build
  run_gate coverage-prerequisites-clean cargo clean
  run_gate coverage-runtime bash -c \
    'cd packages/runtime && exec node --test --experimental-test-coverage test/*.test.mjs'
  check_coverage_floor js "${REPORT_DIR}/coverage-runtime.log" "${COVERAGE_RUNTIME_LINES_FLOOR}"
  run_gate coverage-native bash -c \
    'cd packages/node && exec node --test --experimental-test-coverage test/*.test.mjs'
  check_coverage_floor js "${REPORT_DIR}/coverage-native.log" "${COVERAGE_NATIVE_LINES_FLOOR}"
}

coverage() {
  coverage_rust
  coverage_js
}

native_current_host() {
  local expected
  expected="$(node --input-type=module -e \
    'import { nativePrebuildPackageName } from "./packages/node/binding.js";
     const name = nativePrebuildPackageName({});
     if (!name) process.exit(1);
     process.stdout.write(name);')"
  run_gate native-package pnpm --filter @ferrite/node prebuild:package
  run_gate native-verify pnpm --filter @ferrite/node prebuild:verify --expect "${expected}"
}

nginx() {
  command -v docker >/dev/null || fail "Docker is required for the nginx proof"
  docker info >/dev/null 2>&1 || fail "Docker is installed but its daemon is unavailable"
  run_gate nginx-stack pnpm test:nginx:stack
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
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
  coverage-rust)
    preflight
    bootstrap
    coverage_rust
    ;;
  coverage-js)
    preflight
    bootstrap
    coverage_js
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
    printf 'usage: %s {preflight|verify|packages|coverage|coverage-rust|coverage-js|native|nginx|all}\n' "$0" >&2
    exit 64
    ;;
esac
fi
