# Buildkite local CI

Ferrite uses a self-hosted Buildkite agent on a dedicated local macOS arm64
queue. GitHub Actions workflows are not part of the current validation path.
Buildkite supplies scheduling and logs; the user's machine supplies the
compute.

This is local-agent evidence, not hosted-runner or production proof. One Mac
cannot establish Linux, Windows, Intel macOS, or clean external-machine
compatibility.

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
5. measured Rust/runtime/native coverage reports without inventing a threshold;
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
- allow only the pipeline upload and full proof commands; and
- clear interactive Git/SSH credential helpers before project commands; and
- force checkout cleanup, disable command evaluation, repository-local hooks,
  plugins, and submodules, and disconnect after one job or five idle minutes
  through the dedicated agent configuration.

The existing shared `default` queue and its global hooks are not suitable for
Ferrite. Use the dedicated configuration and queue:

```sh
export FERRITE_BUILDKITE_APPROVED_COMMIT="$(git rev-parse HEAD)"
buildkite-agent start \
  --config deploy/buildkite/ferrite-agent.cfg.example \
  --disconnect-after-job
```

Supply the agent token through the process environment or an external
credential store. Never add it to this repository, the pipeline YAML, a hook,
or a build artifact.

## Buildkite pipeline settings

Creating or changing the Buildkite account pipeline is an external
administrative action. Configure it separately with:

- repository `git@github.com:integrate-your-mind/ferrite.git`;
- bootstrap command `./.buildkite/scripts/upload-pipeline.sh`;
- fork pull-request builds disabled;
- no pipeline environment secrets; and
- queue `ferrite-local` with `project=ferrite`, `os=darwin`, and `arch=arm64`.

Before enabling automatic builds, manually review and pin the exact commit,
start a one-job agent, and verify that the Buildkite build reports that SHA.

## Local validation

The pipeline and its normal/failure/odd trust paths can be checked without
connecting an agent:

```sh
buildkite-agent pipeline upload \
  --dry-run \
  --format yaml \
  --reject-secrets \
  --agent-access-token local-validation-only \
  .buildkite/pipeline.yml
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
