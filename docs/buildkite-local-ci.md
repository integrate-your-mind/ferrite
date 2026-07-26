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
rustup with Rust 1.95.x and the `wasm32-unknown-unknown` target, Docker, and
Buildkite Agent 3.127.x. The lane invokes the pinned pnpm executable directly
because current Homebrew Node releases do not bundle Corepack. It places the
rustup proxies ahead of Homebrew Rust so a clean WASM build cannot be masked by
artifacts from another toolchain.

## Pipeline

The Buildkite pipeline has one bounded command:

```sh
./.buildkite/scripts/ci.sh all
```

It runs, in order:

1. exact-commit, clean-checkout, host, and toolchain preflight;
2. frozen dependency installation;
3. lint, typecheck, build, and the full Rust/Node/browser/demo test suite;
4. npm/Cargo package verification, dependency audits, site validation, pipeline
   validation, and a committed-head secret scan;
5. measured Rust/runtime/native coverage reports without inventing a threshold
   or overriding `cargo-llvm-cov`'s instrumentation compiler;
6. the current macOS arm64 native-prebuild package and checksum verifier; and
7. the pinned nginx stack.

The nginx stage fails closed when Docker or its daemon is unavailable. Reports
and package candidates are uploaded from `dist/ci/` and `dist/npm-packages/`.
No deploy, publish, release, registry credential, or production-data command is
present.

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
install -m 0755 deploy/buildkite/hooks/environment \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/environment
install -m 0755 deploy/buildkite/hooks/pre-command \
  /opt/homebrew/etc/buildkite-agent/ferrite-hooks/pre-command
```

The external hooks:

- allow only the Ferrite repository;
- reject fork pull requests;
- require the job SHA to equal an operator-approved SHA;
- reject common application and registry credentials;
- allow only the pipeline upload and full proof commands;
- clear interactive Git/SSH credential helpers before project commands; and
- force checkout cleanup, allowlist inherited environment variables, disable
  repository-local hooks, plugins, and submodules, and disconnect after five
  idle minutes or 135 minutes of uptime through the dedicated agent
  configuration.

Buildkite's `no-command-eval` mode is intentionally not enabled because it
rejects the argument-bearing `./.buildkite/scripts/ci.sh all` command. The
external `pre-command` hook is the command allowlist and must be installed
before this queue is used.

The existing shared `default` queue and its global hooks are not suitable for
Ferrite. Use the dedicated configuration and queue:

```sh
export FERRITE_BUILDKITE_APPROVED_COMMIT="$(git rev-parse HEAD)"
buildkite-agent start \
  --config deploy/buildkite/ferrite-agent.cfg.example
```

The first job uploads the repository pipeline and the second runs the proof.
The same agent remains available for both, then exits on the configured idle
or uptime bound.

Supply the agent token through the process environment or an external
credential store. Never add it to this repository, the pipeline YAML, a hook,
or a build artifact.

The example allowlist keeps only the local toolchain, temporary-directory,
locale, read-only checkout credential, and approved-commit inputs. Buildkite's
own job variables are permitted by the agent. Project commands clear the
checkout credential plus `BASH_ENV`, `ENV`, `CDPATH`, `GIT_ASKPASS`, and
`GIT_SSH_COMMAND`.

## Buildkite pipeline settings

Creating or changing the Buildkite account pipeline is an external
administrative action. Configure it separately with:

- repository `git@github.com:integrate-your-mind/ferrite.git`;
- bootstrap command `./.buildkite/scripts/upload-pipeline.sh`;
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
./.buildkite/scripts/upload-pipeline.sh --dry-run
node --test scripts/verify-buildkite.test.mjs
```

Run individual stages for diagnosis:

```sh
./.buildkite/scripts/ci.sh verify
./.buildkite/scripts/ci.sh packages
./.buildkite/scripts/ci.sh coverage
./.buildkite/scripts/ci.sh native
./.buildkite/scripts/ci.sh nginx
```

An individual local command is useful evidence, but only a Buildkite job tied
to the exact pushed SHA is Buildkite execution proof.
