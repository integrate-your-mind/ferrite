# Buildkite local CI

Ferrite uses a self-hosted Buildkite agent on a dedicated local macOS arm64
queue. GitHub Actions workflows are not part of the current validation path.
Buildkite supplies scheduling and logs; the user's machine supplies the
compute.

This is local-agent evidence, not hosted-runner or production proof. One Mac
cannot establish Linux, Windows, Intel macOS, or clean external-machine
compatibility.

This is a deliberate coverage reduction from the removed workflows: the local
lane retains every source-validation category and the current-host native
package check, but it cannot run the previous Linux verification or Darwin
x64, Linux arm64/x64, and Windows x64 native artifact jobs. Those platforms and
the aggregate five-artifact check remain unproven release gates.

The current pipeline is pinned to Buildkite Agent 3.127.x because it uses the
v3 `pipeline upload --reject-secrets` fail-closed check. Upgrading to another
agent series requires reviewing that command and this trust contract first.
The isolated agent `PATH` must provide Node.js 22 or newer, pnpm 11.7.0,
rustup with Rust 1.95.0 and the `wasm32-unknown-unknown` target, cargo-audit,
cargo-llvm-cov, Docker, and Buildkite Agent 3.127.x. The environment hook
copies the rustup proxies needed by Cargo, Rustc, Clippy, rustfmt, and rustdoc
into its private toolchain bin. Preflight resolves all six tools through the
same pinned rustup toolchain and fails closed if any tool resolves elsewhere.
Preflight accepts only absolute regular executable paths, requires every
canonicalization to succeed, and rejects inherited shell functions before any
repository command can run. The environment receipt records rustup and all six
tool paths plus full Cargo and Rustc version details, including the LLVM
identity that distinguishes incompatible same-version distributors. The two
standalone Cargo subcommand executables are also copied into the private
toolchain bin when present; preflight fails closed if either required
executable is absent.
The lane invokes the pinned pnpm executable directly
because current Homebrew Node releases do not bundle Corepack. It places the
rustup proxies ahead of Homebrew Rust so a clean WASM build cannot be masked by
artifacts from another toolchain.

## Pipeline

The Buildkite pipeline has six bounded, dependency-ordered commands:

```sh
./.buildkite/scripts/ci.mjs verify
./.buildkite/scripts/ci.mjs packages
./.buildkite/scripts/ci.mjs coverage-rust
./.buildkite/scripts/ci.mjs coverage-js
./.buildkite/scripts/ci.mjs native
./.buildkite/scripts/ci.mjs nginx
```

Each job starts from the agent's clean exact-commit checkout. Splitting the
existing modes prevents generated output from one gate from accumulating into
the next gate while preserving this order. The CI script disables incremental
Rust output, strips development debug information, and uses one Cargo build
job so a clean proof has a bounded generated-output footprint. Rust and
JavaScript coverage run in separate clean jobs. The JavaScript coverage job
builds only its ignored runtime and native prerequisites, copies their
distributable artifacts, then removes the prerequisite Rust target before
starting the Node coverage runs.

Only direct `cargo llvm-cov` uses its supported `--locked` flag. `cargo audit`
does not provide that flag; it reads the checked-out lockfile under the same
post-gate digest/cleanliness contract. Cargo commands nested inside existing
pnpm scripts do not receive a portable lock flag; their fail-closed contract is
the clean checkout plus the start/end `Cargo.lock` SHA-256 and worktree checks.
`cargo fmt` and `cargo clean` do not support `--locked`. Coverage is a measured gate: the workspace Rust lines floor
is 90.00%, runtime JavaScript is 80.00%, and native JavaScript is 78.00%.
Rust parsing requires a `TOTAL` lines percentage; Node parsing requires a
well-formed `# all files | ...` summary. Empty, malformed, or under-floor
reports fail closed. These floors sit below the current exact results (90.99%,
81.57%, and 79.50%) to detect regressions without pretending to be a quality
target.

Each of the six proof-mode jobs checks storage before creating reports,
installing dependencies, or building source. It fails closed unless the
checkout volume has at least 20 GiB available, then records the observed and
required KiB values in `dist/ci/environment.txt`. The pipeline-upload bootstrap
does not build source or create proof reports. Do not bypass the proof-mode
guard to turn an `ENOSPC` failure into a nominal CI result.

Each gate records its starting commit, tree, `Cargo.lock` SHA-256, and
worktree status, then verifies that all four are unchanged before reporting a
successful gate. This catches accidental checkout or lockfile mutation even
when the child process itself exits zero; ignored build output remains allowed.

1. exact-commit, clean-checkout, host, and toolchain preflight;
2. frozen dependency installation;
3. lint, typecheck, build, and the full Rust/Node/browser/demo test suite;
4. npm/Cargo package verification, dependency audits, site validation,
   pipeline validation, and a committed-head secret scan;
5. measured Rust/runtime/native coverage reports without inventing a threshold
   or overriding `cargo-llvm-cov`'s instrumentation compiler;
6. the current macOS arm64 native-prebuild package and checksum verifier; and
7. the pinned nginx stack.

The next job is not scheduled when its dependency fails. The nginx stage fails
closed when Docker or its daemon is unavailable. Each job uploads its reports
and package candidates from `dist/ci/` and `dist/npm-packages/`. No deploy,
publish, release, registry credential, or production-data command is present.
After the package job and artifact upload finish, the separate release planner
must authenticate to the Buildkite API and bind the downloaded report and
tarballs to the exact passed package job's artifact metadata. The package job
cannot validate artifacts that Buildkite has not uploaded yet.

## Trust boundary

A self-hosted agent executes repository code with the operating-system
permissions of its agent account. Do not route arbitrary fork code, unreviewed
commits, production credentials, signing keys, personal browser state, or
unrelated project jobs to this queue.

Use a dedicated least-privilege macOS account when practical. Give it only
read access to this repository and the tools needed for validation. Do not give
it access to personal files, browser profiles, production infrastructure, or
registry/signing credentials.

The repository includes templates under `deploy/buildkite/`, but checked-out
hooks are not a trust boundary. Install reviewed copies outside the checkout:

```sh
install -d -m 0755 /opt/homebrew/etc/buildkite-agent/ferrite-hooks
install -m 0755 deploy/buildkite/hooks/pre-bootstrap \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/pre-bootstrap
install -m 0755 deploy/buildkite/hooks/environment \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/environment
install -m 0755 deploy/buildkite/hooks/pre-command \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/pre-command
install -m 0755 deploy/buildkite/hooks/pre-exit \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/pre-exit
```

The external hooks:

- inspect the proposed job JSON from a non-Bash `pre-bootstrap` hook before
  checkout, reject imported functions and other interpreter/toolchain
  injection variables, and allow only the Ferrite repository, exact commands,
  and operator-approved commit;
- reject fork pull requests;
- require the job SHA to equal an operator-approved SHA;
- reject common application and registry credentials;
- replace `HOME` with a mode-0700 per-build directory and point npm, Cargo,
  Docker, AWS, Google Cloud, and Git config/credential paths at separate empty
  or valid-empty files and directories there;
- canonicalize and validate `TMPDIR` before deriving that per-build directory;
  the private PATH installs rustup proxies for Cargo, Rustc, Clippy, rustfmt,
  and rustdoc and copies `cargo-audit` and `cargo-llvm-cov` when available,
  while preflight pins Rust 1.95.0 and requires every tool;
- remove `$HOME/bin`, `$HOME/.cargo/bin`, and `$HOME/Library/pnpm` from the
  executed `PATH` (rustup proxies are copied into the per-build toolchain bin
  directory when the operator-installed toolchain is present);
- allow only the pipeline upload and six proof-mode commands;
- recheck the exact command and dangerous environment variables from a
  non-Bash `pre-command` hook; the Node CI entrypoint rejects imported
  functions again, removes the other denied variables, and starts the internal
  Bash runner with that sanitized environment; and
- remove the exact exported per-build HOME from `TMPDIR` in the global
  `pre-exit` hook after validating its basename and path; cleanup is idempotent
  and fails closed for malformed or symlink paths; and
- force checkout cleanup, allowlist inherited environment variables, disable
  repository-local hooks, plugins, and submodules, and disconnect after five
  idle minutes or 240 minutes of uptime through the dedicated agent
  configuration.

Buildkite's `no-command-eval` mode is intentionally not enabled because it
rejects the argument-bearing proof-mode commands. The external
`pre-bootstrap` and `pre-command` hooks are the exact command allowlist and
must both be installed before this queue is used. Buildkite Agent 3.127 runs
these extensionless Node hooks as polyglot hooks; unlike shell hooks, their
environment mutations would not propagate, so the repository Node entrypoint
also sanitizes the environment before starting the internal Bash runner.

The existing shared `default` queue and its global hooks are not suitable for
Ferrite. Use the dedicated configuration and queue:

```sh
export FERRITE_BUILDKITE_APPROVED_COMMIT="$(git rev-parse HEAD)"
buildkite-agent start \
  --config deploy/buildkite/ferrite-agent.cfg.example
```

The first job uploads the repository pipeline and the six dependency-ordered
proof jobs reuse the same bounded agent. The agent then exits on the configured
idle or uptime bound.

Rolling this change back requires restoring both sides of the trust boundary:
stop the bounded agent, restore the previous repository pipeline and external
hook from the same commit, verify their hashes, then restart the agent against
the approved SHA. Reverting only the repository or only the installed hook
leaves the job commands incompatible.

Supply the agent token through the process environment or an external
credential store. Never add it to this repository, the pipeline YAML, a hook,
or a build artifact.

The example allowlist keeps only the local toolchain, temporary-directory,
locale, and approved-commit inputs. Buildkite's own job variables are
permitted by the agent. The pre-bootstrap hook rejects imported Bash
functions, interpreter startup variables, dynamic-loader variables, and Rust
wrapper/flag overrides before any shell hook runs. A checkout-only Git/SSH
helper is accepted only when it exactly matches the operator environment; both
repository entrypoints remove those helpers before invoking project or
Buildkite commands.

The empty per-build locations and command allowlist are policy isolation, not a
mechanical same-UID sandbox: code running as the agent account can still read
or modify anything that account can access, including installed tools and
other jobs' data. A dedicated least-privilege OS account (and separate host or
VM for hostile-code isolation) is required for that stronger boundary. This
configuration does not claim to provide it.

Install the reviewed `pre-exit` hook alongside the pre-bootstrap, environment,
and pre-command hooks. It deletes only `FERRITE_BUILDKITE_BUILD_HOME` when that
path is exactly under `TMPDIR` with a `ferrite-buildkite-home-*` basename; it
never cleans a general temporary directory.

## Buildkite pipeline settings

Creating or changing the Buildkite account pipeline is an external
administrative action. Configure it separately with:

- repository `git@github.com:integrate-your-mind/ferrite.git`;
- bootstrap command `./.buildkite/scripts/upload-pipeline.mjs`;
- fork pull-request builds disabled;
- no pipeline environment secrets; and
- queue `ferrite-local` with `project=ferrite`, `os=darwin`, and `arch=arm64`.

Before enabling automatic builds, manually review and pin the exact commit,
start the bounded reusable agent described above, and verify that both the
pipeline-upload job and proof job report that SHA.

## Local validation

The pipeline and its normal/failure/odd trust paths can be checked without
connecting an agent:

```sh
./.buildkite/scripts/upload-pipeline.mjs --dry-run
node --test scripts/verify-buildkite.test.mjs
```

Run individual stages for diagnosis:

```sh
./.buildkite/scripts/ci.mjs verify
./.buildkite/scripts/ci.mjs packages
./.buildkite/scripts/ci.mjs coverage-rust
./.buildkite/scripts/ci.mjs coverage-js
./.buildkite/scripts/ci.mjs native
./.buildkite/scripts/ci.mjs nginx
```

An individual local command is useful evidence, but only a Buildkite job tied
to the exact pushed SHA is Buildkite execution proof.
