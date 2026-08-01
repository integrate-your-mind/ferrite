# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE} AS node-toolchain

FROM ${RUST_IMAGE} AS builder
WORKDIR /workspace
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY --from=node-toolchain /usr/local/ /usr/local/

RUN rustc --version | grep -q '^rustc 1\.95\.0 ' \
  && node --version | grep -q '^v24\.' \
  && corepack --version \
  && rustup target add wasm32-unknown-unknown \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && corepack enable pnpm \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && cargo install --path crates/ferrite-cli --locked --root /opt/ferrite \
  && /opt/ferrite/bin/ferrite build --project examples/basic

FROM ${NODE_IMAGE} AS runtime
WORKDIR /srv/ferrite

RUN useradd --create-home --home-dir /home/ferrite --shell /usr/sbin/nologin ferrite

COPY --from=builder /opt/ferrite/bin/ferrite /usr/local/bin/ferrite
COPY --from=builder /workspace/packages/runtime/bin/render-artifact.mjs ./render-artifact.mjs
COPY --from=builder /workspace/examples/basic/.ferrite/build ./app/.ferrite/build
RUN chown -R ferrite:ferrite /srv/ferrite

ENV NODE_ENV=production \
  FERRITE_PUBLIC_ORIGIN=https://app.example.com

USER ferrite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "exec ferrite serve --project /srv/ferrite/app --artifact .ferrite/build --page-renderer /srv/ferrite/render-artifact.mjs --host 0.0.0.0 --port 3000 --render-timeout-ms 30000 --request-read-timeout-ms 5000 --response-write-timeout-ms 5000 --max-request-bytes 16384 --max-in-flight-requests 64 --server-action-csrf-token-env FERRITE_ACTION_CSRF --server-action-csrf-cookie-name ferrite_action_csrf --server-action-replay-ttl-ms 300000 --trusted-proxy-public-origin \"$FERRITE_PUBLIC_ORIGIN\" --trusted-proxy-client-ip-hops 1 --access-log json --action-log json"]
