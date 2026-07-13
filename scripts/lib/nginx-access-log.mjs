import assert from "node:assert/strict";
import { isIP } from "node:net";

export const NGINX_FRAMING_PROBE_NAMES = Object.freeze([
  "duplicate-content-length",
  "conflicting-content-length",
  "comma-content-length",
  "transfer-encoding-content-length",
  "duplicate-transfer-encoding",
]);

export const nginxFramingProbeTarget = (name) =>
  `/_ferrite/action?__ferrite_framing_probe=${encodeURIComponent(name)}`;

export const parseAccessLogEntries = (log) =>
  log.split(/\r?\n/).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === "object" ? [entry] : [];
    } catch {
      return [];
    }
  });

const assertBaselineEntry = (entries, expected) => {
  const entry = entries.find(
    (candidate) =>
      candidate.method === expected.method &&
      candidate.path === expected.path &&
      candidate.status === expected.status,
  );

  assert.ok(
    entry,
    `Ferrite access log omitted ${expected.method} ${expected.path} status ${expected.status}`,
  );
  assert.equal(
    entry.route_pattern,
    expected.routePattern,
    `${expected.method} ${expected.path} recorded the wrong route pattern`,
  );
  assert.equal(
    isIP(entry.client_ip),
    4,
    `${expected.method} ${expected.path} did not record a valid trusted-proxy IPv4 client address`,
  );
  assert.ok(
    Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0,
    `${expected.method} ${expected.path} recorded an invalid elapsed_ms`,
  );
  return entry;
};

const assertActionEntry = (entries, routePath, expectedClientIp) => {
  const entry = entries.find(
    (candidate) =>
      candidate.route_path === routePath &&
      candidate.status === 200 &&
      candidate.outcome === "accepted",
  );
  assert.ok(entry, `Ferrite action log omitted accepted route ${routePath}`);
  assert.equal(
    entry.action_id,
    "app/posts/[id]/page.tsx#savePost",
    `Ferrite action log recorded the wrong action id for ${routePath}`,
  );
  assert.equal(
    entry.route_pattern,
    "/posts/:id",
    `Ferrite action log recorded the wrong route pattern for ${routePath}`,
  );
  assert.equal(
    entry.client_ip,
    expectedClientIp,
    `Ferrite action log recorded the wrong trusted-proxy client for ${routePath}`,
  );
  assert.ok(
    Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0,
    `Ferrite action log recorded an invalid elapsed_ms for ${routePath}`,
  );
};

export const assertNginxAccessLogEvidence = (
  entries,
  smugglingCanaryPaths,
  { additionalAccessEntries = [], expectedActionRoutes = [], forbiddenClientIps = [] } = {},
) => {
  const baseline = assertBaselineEntry(entries, {
    method: "GET",
    path: "/posts/abc",
    status: 200,
    routePattern: "/posts/:id",
  });
  assertBaselineEntry(entries, {
    method: "POST",
    path: "/_ferrite/action",
    status: 200,
    routePattern: "/posts/:id",
  });
  for (const expected of additionalAccessEntries) {
    const entry = assertBaselineEntry(entries, expected);
    assert.equal(
      entry.client_ip,
      baseline.client_ip,
      `${expected.method} ${expected.path} recorded a different trusted-proxy client`,
    );
  }
  for (const routePath of expectedActionRoutes) {
    assertActionEntry(entries, routePath, baseline.client_ip);
  }

  for (const forbiddenClientIp of forbiddenClientIps) {
    assert.ok(
      !entries.some((entry) => entry.client_ip === forbiddenClientIp),
      `untrusted forwarded client IP reached Ferrite logs: ${forbiddenClientIp}`,
    );
  }

  const paths = new Set(entries.map((entry) => entry.path));
  for (const canaryPath of smugglingCanaryPaths) {
    assert.ok(!paths.has(canaryPath), `smuggling canary reached Ferrite: ${canaryPath}`);
  }
};

export const assertNginxFramingRejectedAtProxy = (
  entries,
  probeNames = NGINX_FRAMING_PROBE_NAMES,
) => {
  for (const probeName of probeNames) {
    const request = `POST ${nginxFramingProbeTarget(probeName)} HTTP/1.1`;
    const matches = entries.filter((entry) => entry.request === request);
    assert.equal(matches.length, 1, `nginx access log omitted framing probe ${probeName}`);

    const [entry] = matches;
    assert.equal(entry.status, 400, `nginx framing probe ${probeName} returned the wrong status`);
    assert.ok(
      entry.upstream_status === "-" || entry.upstream_status === "",
      `nginx framing probe ${probeName} reached Ferrite upstream with status ${entry.upstream_status}`,
    );
  }
};
