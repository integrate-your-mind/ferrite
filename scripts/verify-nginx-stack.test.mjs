import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertNginxAccessLogEvidence,
  assertNginxFramingRejectedAtProxy,
  assertNginxRequestTargetsRejectedAtProxy,
  NGINX_FRAMING_PROBE_NAMES,
  nginxFramingProbeTarget,
  nginxHttp2RequestTargetRejectionProbes,
  nginxRequestTargetRejectionProbes,
  parseAccessLogEntries,
} from "./lib/nginx-access-log.mjs";
import {
  assertExpectedFailure,
  assertProofSourceState,
  CleanupStack,
  createCleanSourceSnapshot,
  createProofInterruption,
  formatProofError,
  parseDockerPublishedPort,
  renderMissingCertificateControlConfig,
  renderProofNginxConfig,
  resolveProofInputPaths,
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
  const rendered = renderProofNginxConfig(template);
  assert.match(rendered, /log_format ferrite_proof escape=json/);
  assert.match(rendered, /access_log \/var\/log\/nginx\/access\.log ferrite_proof/);
  assert.match(rendered, /proxy_pass http:\/\/ferrite-upstream:3000/);
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

test("missing-certificate control does not depend on proof-network DNS", () => {
  const template = "server { proxy_pass http://127.0.0.1:3000; }";
  const rendered = renderMissingCertificateControlConfig(template);
  assert.match(rendered, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(rendered, /ferrite-upstream/);
  assert.match(rendered, /log_format ferrite_proof escape=json/);
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

test("clean nginx proof snapshots every tracked proof input from one immutable Git commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-proof-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "proof@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ferrite Proof"], { cwd: root });
  await mkdir(join(root, "deploy/container"), { recursive: true });
  await mkdir(join(root, "deploy/nginx"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "source.txt"), "committed source");
  await writeFile(join(root, "deploy/container/Dockerfile"), "committed Dockerfile");
  await writeFile(join(root, "deploy/nginx/ferrite.conf"), "committed nginx template");
  await writeFile(join(root, "scripts/verify-nginx-runtime.mjs"), "committed verifier");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const scratch = join(root, "scratch");
  await mkdir(scratch);

  const snapshot = await createCleanSourceSnapshot({ sourceRoot: root, scratch, commit });
  await writeFile(join(root, "source.txt"), "mutated after snapshot");
  await writeFile(join(root, "deploy/container/Dockerfile"), "mutated Dockerfile");
  await writeFile(join(root, "deploy/nginx/ferrite.conf"), "mutated nginx template");
  await writeFile(join(root, "scripts/verify-nginx-runtime.mjs"), "mutated verifier");
  const proofInputs = resolveProofInputPaths(snapshot);

  assert.equal(await readFile(join(snapshot, "source.txt"), "utf8"), "committed source");
  assert.equal(await readFile(proofInputs.dockerfile, "utf8"), "committed Dockerfile");
  assert.equal(await readFile(proofInputs.nginxTemplate, "utf8"), "committed nginx template");
  assert.equal(await readFile(proofInputs.verifier, "utf8"), "committed verifier");
  await assert.rejects(access(join(snapshot, ".git")), (error) => error.code === "ENOENT");
});

test("framing probes must be rejected before an upstream response", () => {
  const proxyRejections = NGINX_FRAMING_PROBE_NAMES.map((name) => ({
    request: `POST ${nginxFramingProbeTarget(name)} HTTP/1.1`,
    status: 400,
    upstream_status: "-",
  }));
  assert.doesNotThrow(() => assertNginxFramingRejectedAtProxy(proxyRejections));
  assert.throws(
    () =>
      assertNginxFramingRejectedAtProxy([
        { ...proxyRejections[0], upstream_status: "400" },
        ...proxyRejections.slice(1),
      ]),
    /reached Ferrite upstream with status 400/,
  );
  assert.throws(
    () => assertNginxFramingRejectedAtProxy(proxyRejections.slice(1)),
    /omitted framing probe duplicate-content-length/,
  );
});

test("request-target probes must be rejected before an upstream response", () => {
  const probes = [
    ...nginxRequestTargetRejectionProbes("app.example.com"),
    ...nginxHttp2RequestTargetRejectionProbes,
  ];
  const proxyRejections = probes.map((probe) => ({
    request: `GET ${probe.target} ${probe.httpVersion ?? "HTTP/1.1"}`,
    status: 421,
    upstream_status: "-",
  }));
  assert.doesNotThrow(() =>
    assertNginxRequestTargetsRejectedAtProxy(proxyRejections, probes),
  );
  assert.throws(
    () =>
      assertNginxRequestTargetsRejectedAtProxy(
        [{ ...proxyRejections[0], upstream_status: "421" }, ...proxyRejections.slice(1)],
        probes,
      ),
    /reached Ferrite upstream with status 421/,
  );
  assert.throws(
    () => assertNginxRequestTargetsRejectedAtProxy(proxyRejections.slice(1), probes),
    /omitted request-target probe literal backslash origin-form target/,
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

test("proof error output preserves primary, cleanup, and nested cause details", () => {
  const primary = new Error("candidate image build failed");
  const cleanupCause = new Error("Docker daemon stopped responding");
  const cleanup = new Error("candidate image cleanup failed", { cause: cleanupCause });
  const failure = new AggregateError(
    [primary, new AggregateError([cleanup], "nginx proof cleanup failed")],
    "nginx proof and cleanup failed",
  );

  const output = formatProofError(failure);
  assert.match(output, /nginx proof and cleanup failed/);
  assert.match(output, /candidate image build failed/);
  assert.match(output, /nginx proof cleanup failed/);
  assert.match(output, /candidate image cleanup failed/);
  assert.match(output, /Docker daemon stopped responding/);

  const circular = new Error("circular cleanup failure");
  circular.cause = circular;
  assert.match(formatProofError(circular), /cause: \[circular Error\]/);
  assert.equal(formatProofError("non-error failure"), "non-error failure");

  const shared = new Error("shared cleanup failure");
  const sharedOutput = formatProofError(
    new AggregateError([shared, shared], "repeated cleanup failure"),
  );
  assert.equal(sharedOutput.match(/Error: shared cleanup failure/g)?.length, 2);
  assert.doesNotMatch(sharedOutput, /\[circular Error\]/);
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
    /unexpected reason:\n\nconnection refused/,
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
