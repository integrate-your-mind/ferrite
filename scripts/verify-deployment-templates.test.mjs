import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("deployment templates keep production serve flags aligned", async () => {
  const dockerfile = await text("deploy/container/Dockerfile");
  const systemd = await text("deploy/systemd/ferrite.service");
  const env = await text("deploy/ferrite.env.example");

  for (const source of [dockerfile, systemd]) {
    assert.match(source, /ferrite serve/);
    assert.match(source, /--request-read-timeout-ms 5000/);
    assert.match(source, /--max-request-bytes 16384/);
    assert.match(source, /--max-in-flight-requests 64/);
    assert.match(source, /--server-action-csrf-token-env FERRITE_ACTION_CSRF/);
    assert.match(source, /--server-action-csrf-cookie-name ferrite_action_csrf/);
    assert.match(source, /--server-action-replay-ttl-ms 300000/);
    assert.match(source, /--trusted-proxy-public-origin/);
    assert.match(source, /--trusted-proxy-client-ip-hops 1/);
    assert.match(source, /--access-log json/);
    assert.match(source, /--action-log json/);
    assert.match(source, /--metrics-path \/__ferrite\/metrics/);
  }

  assert.match(systemd, /--host 127\.0\.0\.1/);
  assert.match(dockerfile, /--host 0\.0\.0\.0/);
  assert.match(env, /^FERRITE_ACTION_CSRF=/m);
  assert.match(env, /^FERRITE_PUBLIC_ORIGIN=https:\/\/app\.example\.com$/m);
});

test("proxy template owns the forwarded headers trusted by Ferrite", async () => {
  const nginx = await text("deploy/nginx/ferrite.conf");

  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(nginx, /proxy_set_header Host \$host;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Host \$host;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.match(nginx, /client_max_body_size 16k;/);
});

test("container template runs as a non-root runtime user with a health check", async () => {
  const dockerfile = await text("deploy/container/Dockerfile");
  const dockerignore = await text(".dockerignore");

  assert.match(dockerfile, /USER ferrite/);
  assert.match(dockerfile, /chown -R ferrite:ferrite \/srv\/ferrite/);
  assert.match(dockerfile, /\/srv\/ferrite\/app\/node_modules\/@ferrite/);
  assert.match(dockerfile, /ln -s \/srv\/ferrite\/packages\/runtime \/srv\/ferrite\/app\/node_modules\/@ferrite\/runtime/);
  assert.match(dockerfile, /ln -s \/srv\/ferrite\/packages\/protocol \/srv\/ferrite\/node_modules\/@ferrite\/protocol/);
  assert.match(dockerfile, /HEALTHCHECK /);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.doesNotMatch(dockerfile, /FERRITE_ACTION_CSRF=[a-zA-Z0-9_-]{24,}/);
  assert.match(dockerignore, /^target$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\*\*\/\.ferrite$/m);
  assert.match(dockerignore, /^\*\*\/node_modules$/m);
});
