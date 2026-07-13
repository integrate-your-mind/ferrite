import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNginxAccessLogEvidence,
  parseAccessLogEntries,
} from "./lib/nginx-access-log.mjs";
import {
  assertExpectedFailure,
  CleanupStack,
  parseDockerPublishedPort,
  renderProofNginxConfig,
} from "./verify-nginx-stack.mjs";

const canaryPaths = ["/posts/nginx-smuggle-duplicate-content-length"];
const baselineEntries = [
  {
    method: "GET",
    path: "/posts/abc",
    status: 200,
    route_pattern: "/posts/:id",
    client_ip: "192.0.2.10",
    elapsed_ms: 2,
  },
  {
    method: "POST",
    path: "/_ferrite/action",
    status: 200,
    route_pattern: "/posts/:id",
    client_ip: "192.0.2.10",
    elapsed_ms: 3,
  },
];

test("nginx proof config replaces one validated upstream without shell interpolation", () => {
  const template = "server { proxy_pass http://127.0.0.1:3000; }";
  assert.equal(
    renderProofNginxConfig(template),
    "server { proxy_pass http://ferrite-upstream:3000; }",
  );
  assert.throws(
    () => renderProofNginxConfig("server {}"),
    /must contain exactly one proxy_pass/,
  );
  assert.throws(
    () => renderProofNginxConfig(`${template}\n${template}`),
    /must contain exactly one proxy_pass/,
  );
  assert.throws(
    () => renderProofNginxConfig(template, "upstream;return-200"),
    /unsupported characters/,
  );
});

test("nginx proof accepts only one loopback Docker port mapping", () => {
  assert.equal(parseDockerPublishedPort("127.0.0.1:49152\n"), 49_152);
  assert.throws(() => parseDockerPublishedPort("0.0.0.0:49152\n"), /unexpected address/);
  assert.throws(
    () => parseDockerPublishedPort("127.0.0.1:49152\n127.0.0.1:49153\n"),
    /exactly one unexpected/,
  );
  assert.throws(() => parseDockerPublishedPort("127.0.0.1:0\n"), /invalid port/);
});

test("cleanup remains LIFO and continues after one cleanup failure", async () => {
  const cleanup = new CleanupStack();
  const order = [];
  cleanup.defer("first", async () => order.push("first"));
  cleanup.defer("broken", async () => {
    order.push("broken");
    throw new Error("synthetic cleanup failure");
  });
  cleanup.defer("last", async () => order.push("last"));

  const errors = await cleanup.run();
  assert.deepEqual(order, ["last", "broken", "first"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /broken: synthetic cleanup failure/);
});

test("expected-failure controls reject success, outer timeout, and wrong failure causes", () => {
  assert.doesNotThrow(() =>
    assertExpectedFailure(
      { code: 1, timedOut: false, stdout: "", stderr: "certificate rejected" },
      "TLS control",
      /certificate rejected/,
    ),
  );
  assert.throws(
    () =>
      assertExpectedFailure(
        { code: 0, timedOut: false, stdout: "ok", stderr: "" },
        "TLS control",
        /certificate rejected/,
      ),
    /unexpectedly succeeded/,
  );
  assert.throws(
    () =>
      assertExpectedFailure(
        { code: null, timedOut: true, stdout: "", stderr: "" },
        "TLS control",
        /certificate rejected/,
      ),
    /outer process deadline/,
  );
  assert.throws(
    () =>
      assertExpectedFailure(
        { code: 1, timedOut: false, stdout: "", stderr: "connection refused" },
        "TLS control",
        /certificate rejected/,
      ),
    /unexpected reason/,
  );
});

test("access-log evidence requires real baseline shape and rejects upstream canaries", () => {
  const parsed = parseAccessLogEntries(
    `not-json\n${baselineEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  assert.equal(parsed.length, 2);
  assert.doesNotThrow(() => assertNginxAccessLogEvidence(parsed, canaryPaths));
  assert.throws(
    () =>
      assertNginxAccessLogEvidence(
        [...parsed, { ...baselineEntries[0], path: canaryPaths[0] }],
        canaryPaths,
      ),
    /smuggling canary reached Ferrite/,
  );
  assert.throws(
    () =>
      assertNginxAccessLogEvidence(
        parsed.map((entry) => ({ ...entry, client_ip: "not-an-ip" })),
        canaryPaths,
      ),
    /valid trusted-proxy IPv4 client address/,
  );
});
