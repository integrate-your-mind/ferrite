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
    assert.match(source, /--artifact \.ferrite\/build/);
    assert.match(source, /render-artifact\.mjs/);
    assert.match(source, /--request-read-timeout-ms 5000/);
    assert.match(source, /--response-write-timeout-ms 5000/);
    assert.match(source, /--max-request-bytes 16384/);
    assert.match(source, /--max-in-flight-requests 64/);
    assert.match(source, /--server-action-csrf-token-env FERRITE_ACTION_CSRF/);
    assert.match(source, /--server-action-csrf-cookie-name ferrite_action_csrf/);
    assert.match(source, /--server-action-replay-ttl-ms 300000/);
    assert.match(source, /--trusted-proxy-public-origin/);
    assert.match(source, /--trusted-proxy-client-ip-hops 1/);
    assert.match(source, /--access-log json/);
    assert.match(source, /--action-log json/);
  }

  assert.match(systemd, /--metrics-path \/__ferrite\/metrics/);
  assert.doesNotMatch(dockerfile, /--metrics-path/);
  assert.match(systemd, /--host 127\.0\.0\.1/);
  assert.match(dockerfile, /--host 0\.0\.0\.0/);
  assert.match(env, /^FERRITE_ACTION_CSRF=/m);
  assert.match(env, /^FERRITE_PUBLIC_ORIGIN=https:\/\/app\.example\.com$/m);
});

test("proxy template owns the forwarded headers trusted by Ferrite", async () => {
  const nginx = await text("deploy/nginx/ferrite.conf");

  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(nginx, /listen 443 ssl;/);
  assert.match(nginx, /http2 on;/);
  assert.doesNotMatch(nginx, /listen 443 ssl http2;/);
  assert.match(nginx, /proxy_http_version 1\.1;/);
  assert.match(nginx, /proxy_request_buffering on;/);
  assert.match(nginx, /proxy_set_header Host \$host;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Host \$host;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginx, /proxy_set_header Connection "";/);
  assert.match(nginx, /proxy_set_header Expect "";/);
  assert.match(
    nginx,
    /map \$http_host \$ferrite_authority_allowed \{\s+default 0;\s+app\.example\.com 1;\s+\}/,
  );
  const targetMap = nginx.match(
    /map \$request \$ferrite_request_target_allowed \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(targetMap, "nginx request-target map is missing");
  assert.match(targetMap, /^\s*default 0;/m);
  assert.match(targetMap, /%\(\?:2e\|2f\|5c\)/);
  assert.match(targetMap, /\\\.\{1,2\}/);
  const rawTargetReject = '"~*^[A-Z]+ [^ ]*(?:#|\\\\x5c)[^ ]* HTTP/" 0;';
  assert.ok(targetMap.includes(rawTargetReject));
  assert.match(targetMap, /"~\*\^\[A-Z\]\+ \/\(\?:\[\^\/ \]\[\^ \]\*\)\? HTTP\/" 1;/);
  assert.match(targetMap, /https:\/\/app\\\.example\\\.com\(\?:\/\|\[\? \]\)/);
  assert.ok(
    targetMap.indexOf("%(?:2e|2f|5c)") < targetMap.indexOf('HTTP/" 1;'),
    "encoded traversal rejection must run before origin-form acceptance",
  );
  assert.ok(
    targetMap.indexOf("\\.{1,2}") < targetMap.indexOf('HTTP/" 1;'),
    "literal dot-segment rejection must run before origin-form acceptance",
  );
  assert.ok(
    targetMap.indexOf(rawTargetReject) < targetMap.indexOf('HTTP/" 1;'),
    "raw fragment/backslash rejection must run before origin-form acceptance",
  );
  assert.match(nginx, /if \(\$host != \$server_name\) \{\s+return 421;\s+\}/);
  assert.match(
    nginx,
    /if \(\$ferrite_authority_allowed = 0\) \{\s+return 421;\s+\}/,
  );
  assert.match(
    nginx,
    /if \(\$ferrite_request_target_allowed = 0\) \{\s+return 421;\s+\}/,
  );
  assert.match(nginx, /location = \/__ferrite\/metrics \{\s+return 404;\s+\}/);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  assert.match(nginx, /client_max_body_size 16k;/);
});

test("container template runs as a non-root runtime user with a health check", async () => {
  const dockerfile = await text("deploy/container/Dockerfile");
  const dockerignore = await text(".dockerignore");

  assert.match(
    dockerfile,
    /ARG RUST_IMAGE=rust:1\.95\.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1/,
  );
  assert.match(dockerfile, /rustc --version \| grep -q '\^rustc 1\\\.95\\\.0 '/);
  assert.doesNotMatch(dockerfile, /ARG RUST_IMAGE=rust:1-bookworm/);
  assert.match(dockerfile, /USER ferrite/);
  assert.match(dockerfile, /ferrite build --project examples\/basic/);
  assert.match(dockerfile, /examples\/basic\/\.ferrite\/build/);
  assert.doesNotMatch(dockerfile, /\/workspace\/examples\/basic \.\/app/);
  assert.match(dockerfile, /chown -R ferrite:ferrite \/srv\/ferrite/);
  assert.match(dockerfile, /packages\/runtime\/bin\/render-artifact\.mjs \.\/render-artifact\.mjs/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder \/workspace\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder \/workspace\/packages \.\/packages/);
  assert.doesNotMatch(dockerfile, /\/srv\/ferrite\/app\/node_modules/);
  assert.match(dockerfile, /HEALTHCHECK /);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.match(dockerfile, /CMD \["sh", "-c", "exec ferrite serve/);
  assert.doesNotMatch(dockerfile, /FERRITE_ACTION_CSRF=[a-zA-Z0-9_-]{24,}/);
  assert.match(dockerignore, /^target$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\*\*\/\.ferrite$/m);
  assert.match(dockerignore, /^\*\*\/node_modules$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/\*\.key$/m);
  assert.match(dockerignore, /^\*\*\/\*\.pem$/m);
});

test("runtime proxy verifier is wired into the package scripts", async () => {
  const packageJson = JSON.parse(await text("package.json"));

  assert.equal(packageJson.scripts["test:nginx"], "node scripts/verify-nginx-runtime.mjs");
  assert.equal(
    packageJson.scripts["test:nginx:stack"],
    "node scripts/verify-nginx-stack.mjs",
  );
  const runtimeVerifier = await text("scripts/verify-nginx-runtime.mjs");
  assert.match(runtimeVerifier, /nginx framing matrix passed/);
  assert.match(runtimeVerifier, /nginx HTTP\/2 matrix passed/);
  assert.match(await text("scripts/verify-nginx-stack.mjs"), /nginx stack proof passed/);
});
