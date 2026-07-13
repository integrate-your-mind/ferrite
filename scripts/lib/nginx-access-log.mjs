import assert from "node:assert/strict";
import { isIP } from "node:net";

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
};

export const assertNginxAccessLogEvidence = (entries, smugglingCanaryPaths) => {
  assertBaselineEntry(entries, {
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

  const paths = new Set(entries.map((entry) => entry.path));
  for (const canaryPath of smugglingCanaryPaths) {
    assert.ok(!paths.has(canaryPath), `smuggling canary reached Ferrite: ${canaryPath}`);
  }
};
