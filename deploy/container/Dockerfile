# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust:1-bookworm
ARG NODE_MAJOR=24

FROM ${RUST_IMAGE} AS builder
ARG NODE_MAJOR
WORKDIR /workspace
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rustup target add wasm32-unknown-unknown \
  && corepack enable \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && cargo install --path crates/ferrite-cli --locked --root /opt/ferrite

FROM node:24-bookworm-slim AS runtime
WORKDIR /srv/ferrite

RUN useradd --create-home --home-dir /home/ferrite --shell /usr/sbin/nologin ferrite

COPY --from=builder /opt/ferrite/bin/ferrite /usr/local/bin/ferrite
COPY --from=builder /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml ./
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages ./packages
COPY --from=builder /workspace/examples/basic ./app
RUN mkdir -p /srv/ferrite/app/node_modules/@ferrite /srv/ferrite/node_modules/@ferrite \
  && rm -f /srv/ferrite/app/node_modules/@ferrite/runtime \
  && rm -f /srv/ferrite/node_modules/@ferrite/runtime /srv/ferrite/node_modules/@ferrite/protocol \
  && ln -s /srv/ferrite/packages/runtime /srv/ferrite/app/node_modules/@ferrite/runtime \
  && ln -s /srv/ferrite/packages/runtime /srv/ferrite/node_modules/@ferrite/runtime \
  && ln -s /srv/ferrite/packages/protocol /srv/ferrite/node_modules/@ferrite/protocol \
  && chown -R ferrite:ferrite /srv/ferrite

ENV NODE_ENV=production \
  FERRITE_PUBLIC_ORIGIN=https://app.example.com

USER ferrite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "ferrite serve --project /srv/ferrite/app --host 0.0.0.0 --port 3000 --render-timeout-ms 30000 --request-read-timeout-ms 5000 --max-request-bytes 16384 --max-in-flight-requests 64 --server-action-csrf-token-env FERRITE_ACTION_CSRF --server-action-csrf-cookie-name ferrite_action_csrf --server-action-replay-ttl-ms 300000 --trusted-proxy-public-origin \"$FERRITE_PUBLIC_ORIGIN\" --trusted-proxy-client-ip-hops 1 --access-log json --action-log json"]
