import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNginxAccessLogEvidence,
  parseAccessLogEntries,
} from "./lib/nginx-access-log.mjs";
import {
  assertExpectedFailure,
  assertProofSourceState,
  CleanupStack,
  createProofInterruption,
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

test("exact nginx proof rejects dirty source unless a development override is explicit", () => {
  assert.doesNotThrow(() => assertProofSourceState(true, false));
  assert.doesNotThrow(() => assertProofSourceState(false, true));
  assert.throws(
    () => assertProofSourceState(false, false),
    /requires a clean worktree/,
  );
});

test("proof interruption escalates workload signals without interrupting cleanup", () => {
  const delivered = [];
  const child = { kill: (signal) => delivered.push(signal) };
  const interruption = createProofInterruption(new Set([child]));

  interruption.interrupt("SIGTERM");
  assert.equal(interruption.signal, "SIGTERM");
  assert.equal(interruption.abortSignal.aborted, true);
  assert.match(interruption.abortSignal.reason.message, /interrupted by SIGTERM/);
  assert.deepEqual(delivered, ["SIGTERM"]);

  interruption.interrupt("SIGINT");
  assert.equal(interruption.signal, "SIGTERM", "first interrupt remains the exit reason");
  assert.deepEqual(delivered, ["SIGTERM", "SIGKILL"]);

  interruption.beginCleanup();
  interruption.interrupt("SIGINT");
  assert.deepEqual(
    delivered,
    ["SIGTERM", "SIGKILL"],
    "cleanup commands must survive repeated process signals",
  );
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

test("access-log evidence correlates HTTP/2 paths, actions, and proxy-owned client IP", () => {
  const entries = [
    ...baselineEntries,
    {
      ...baselineEntries[0],
      path: "/posts/h2-normal",
    },
    {
      action_id: "app/posts/[id]/page.tsx#savePost",
      route_path: "/posts/h2-data",
      route_pattern: "/posts/:id",
      status: 200,
      outcome: "accepted",
      client_ip: "192.0.2.10",
      elapsed_ms: 4,
    },
    {
      action_id: "app/posts/[id]/page.tsx#savePost",
      route_path: "/posts/h2-spoof",
      route_pattern: "/posts/:id",
      status: 200,
      outcome: "accepted",
      client_ip: "192.0.2.10",
      elapsed_ms: 5,
    },
  ];
  const options = {
    additionalAccessEntries: [
      {
        method: "GET",
        path: "/posts/h2-normal",
        status: 200,
        routePattern: "/posts/:id",
      },
    ],
    expectedActionRoutes: ["/posts/h2-data", "/posts/h2-spoof"],
    forbiddenClientIps: ["203.0.113.99"],
  };

  assert.doesNotThrow(() => assertNginxAccessLogEvidence(entries, canaryPaths, options));
  assert.throws(
    () =>
      assertNginxAccessLogEvidence(
        [...entries, { ...baselineEntries[0], client_ip: "203.0.113.99" }],
        canaryPaths,
        options,
      ),
    /untrusted forwarded client IP reached Ferrite logs/,
  );
  assert.throws(
    () =>
      assertNginxAccessLogEvidence(
        entries.filter((entry) => entry.route_path !== "/posts/h2-data"),
        canaryPaths,
        options,
    ),
    /omitted accepted route \/posts\/h2-data/,
  );
  assert.throws(
    () =>
      assertNginxAccessLogEvidence(
        entries.map((entry) =>
          entry.route_path === "/posts/h2-spoof"
            ? { ...entry, action_id: "app/posts/[id]/page.tsx#other" }
            : entry,
        ),
        canaryPaths,
        options,
      ),
    /wrong action id for \/posts\/h2-spoof/,
  );
});
