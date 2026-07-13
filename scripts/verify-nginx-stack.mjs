import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNginxAccessLogEvidence,
  parseAccessLogEntries,
} from "./lib/nginx-access-log.mjs";

export const NGINX_IMAGE =
  "nginx@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repositoryRoot, "scripts/verify-nginx-runtime.mjs");
const activeChildren = new Set();
const maxCapturedBytes = 512 * 1024;
const noSuchDockerObject = /no such (?:container|image|object)|network .* not found/i;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const captureTail = (current, chunk) =>
  `${current}${chunk.toString("utf8")}`.slice(-maxCapturedBytes);

export class CleanupStack {
  #entries = [];

  defer(name, action) {
    this.#entries.push({ name, action });
  }

  async run() {
    const errors = [];
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop();
      try {
        await entry.action();
      } catch (error) {
        errors.push(new Error(`${entry.name}: ${error.message}`, { cause: error }));
      }
    }
    return errors;
  }
}

export const renderProofNginxConfig = (template, upstreamAlias = "ferrite-upstream") => {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(upstreamAlias)) {
    throw new Error("nginx proof upstream alias contains unsupported characters");
  }

  const needle = "proxy_pass http://127.0.0.1:3000;";
  const replacements = template.split(needle).length - 1;
  if (replacements !== 1) {
    throw new Error(`nginx template must contain exactly one ${needle} directive`);
  }
  return template.replace(needle, `proxy_pass http://${upstreamAlias}:3000;`);
};

export const parseDockerPublishedPort = (output) => {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("docker published exactly one unexpected nginx port mapping");
  }
  const match = /^127\.0\.0\.1:(\d+)$/.exec(lines[0]);
  if (!match) {
    throw new Error(`docker published nginx on an unexpected address: ${lines[0]}`);
  }
  const port = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`docker published nginx on an invalid port: ${match[1]}`);
  }
  return port;
};

export const assertExpectedFailure = (result, label, pattern) => {
  assert.notEqual(result.code, 0, `${label} unexpectedly succeeded`);
  assert.equal(result.timedOut, false, `${label} exceeded its outer process deadline`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, pattern, `${label} failed for an unexpected reason`);
};

const runCommand = (
  command,
  args,
  { cwd = repositoryRoot, env = process.env, timeoutMs = 30_000, stream = false } = {},
) =>
  new Promise((resolveCommand, rejectCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceTimer;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = captureTail(stdout, chunk);
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = captureTail(stderr, chunk);
      if (stream) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      activeChildren.delete(child);
      rejectCommand(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      activeChildren.delete(child);
      resolveCommand({ code, signal, stdout, stderr, timedOut });
    });
  });

const assertCommandSucceeded = (result, label) => {
  if (result.code === 0 && !result.timedOut) return result;
  const reason = result.timedOut
    ? "timed out"
    : `exited ${result.code ?? `from ${result.signal}`}`;
  throw new Error(`${label} ${reason}\n${result.stdout}\n${result.stderr}`.trim());
};

const removeDockerResource = async (kind, name) => {
  const inspected = await runCommand("docker", [kind, "inspect", name]);
  if (inspected.code !== 0) {
    if (noSuchDockerObject.test(`${inspected.stdout}\n${inspected.stderr}`)) return;
    assertCommandSucceeded(inspected, `inspect owned Docker ${kind} ${name}`);
  }

  const removeArgs =
    kind === "container"
      ? ["container", "rm", "--force", name]
      : kind === "image"
        ? ["image", "rm", "--force", name]
        : ["network", "rm", name];
  assertCommandSucceeded(
    await runCommand("docker", removeArgs, { timeoutMs: 30_000 }),
    `remove owned Docker ${kind} ${name}`,
  );

  const verified = await runCommand("docker", [kind, "inspect", name]);
  if (verified.code === 0) {
    throw new Error(`owned Docker ${kind} still exists after cleanup: ${name}`);
  }
  if (!noSuchDockerObject.test(`${verified.stdout}\n${verified.stderr}`)) {
    assertCommandSucceeded(verified, `verify owned Docker ${kind} cleanup for ${name}`);
  }
};

const startDockerLogFollower = async (container, path) => {
  const handle = await open(path, "a");
  let spawnError;
  const child = spawn("docker", ["logs", "--follow", "--since", "0s", container], {
    cwd: repositoryRoot,
    stdio: ["ignore", handle.fd, handle.fd],
  });
  activeChildren.add(child);
  const completion = new Promise((resolveCompletion) => {
    child.once("error", (error) => {
      spawnError = error;
      activeChildren.delete(child);
      resolveCompletion();
    });
    child.once("close", () => {
      activeChildren.delete(child);
      resolveCompletion();
    });
  });

  await delay(100);
  if (spawnError || child.exitCode !== null) {
    await handle.close();
    throw spawnError ?? new Error(`docker logs follower exited ${child.exitCode}`);
  }

  let stopped = false;
  return {
    child,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([completion, delay(2_000)]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await completion;
      }
      await handle.sync();
      await handle.close();
    },
  };
};

const waitForFerrite = async (container) => {
  const deadline = Date.now() + 90_000;
  const probe =
    "fetch('http://127.0.0.1:3000/posts/abc').then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))";
  while (Date.now() < deadline) {
    const result = await runCommand("docker", ["exec", container, "node", "-e", probe], {
      timeoutMs: 5_000,
    });
    if (result.code === 0) return;

    const state = await runCommand("docker", ["container", "inspect", "--format", "{{.State.Running}}", container]);
    if (state.code !== 0 || state.stdout.trim() !== "true") {
      const logs = await runCommand("docker", ["logs", container]);
      throw new Error(`Ferrite proof container exited before readiness\n${logs.stdout}\n${logs.stderr}`);
    }
    await delay(250);
  }
  const logs = await runCommand("docker", ["logs", container]);
  throw new Error(`Ferrite proof container was not ready within 90 seconds\n${logs.stdout}\n${logs.stderr}`);
};

const waitForNginxTls = async (port) => {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolveTls, rejectTls) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          servername: "app.example.com",
          rejectUnauthorized: false,
          ALPNProtocols: ["http/1.1"],
        });
        socket.setTimeout(1_000, () => socket.destroy(new Error("TLS readiness timed out")));
        socket.once("error", rejectTls);
        socket.once("secureConnect", () => {
          socket.end();
          resolveTls();
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`nginx TLS listener was not ready within 30 seconds: ${lastError?.message}`);
};

const verifierEnvironment = ({ port, accessLogPath }) => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("FERRITE_NGINX_")) delete environment[key];
  }
  return {
    ...environment,
    FERRITE_NGINX_HOST: "127.0.0.1",
    FERRITE_NGINX_PORT: String(port),
    FERRITE_NGINX_SERVER_NAME: "app.example.com",
    FERRITE_NGINX_INSECURE: "1",
    FERRITE_NGINX_TIMEOUT_MS: "5000",
    FERRITE_NGINX_MAX_RESPONSE_BYTES: "2097152",
    FERRITE_NGINX_ACCESS_LOG_PATH: accessLogPath,
  };
};

const runVerifier = (environment, options = {}) =>
  runCommand(process.execPath, [verifierPath], {
    env: environment,
    timeoutMs: 120_000,
    ...options,
  });

const runStalledTlsDeadlineControl = async (environment) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await runVerifier({
      ...environment,
      FERRITE_NGINX_PORT: String(address.port),
      FERRITE_NGINX_TIMEOUT_MS: "50",
    });
    assertExpectedFailure(result, "stalled TLS deadline control", /timed out after 50 ms/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

const ensurePinnedNginxImage = async () => {
  let inspected = await runCommand("docker", ["image", "inspect", NGINX_IMAGE]);
  if (inspected.code !== 0) {
    process.stdout.write(`Pulling pinned proxy image ${NGINX_IMAGE}\n`);
    assertCommandSucceeded(
      await runCommand("docker", ["pull", NGINX_IMAGE], {
        timeoutMs: 300_000,
        stream: true,
      }),
      "pull pinned nginx image",
    );
    inspected = await runCommand("docker", ["image", "inspect", NGINX_IMAGE]);
  }
  assertCommandSucceeded(inspected, "inspect pinned nginx image");

  const identity = assertCommandSucceeded(
    await runCommand("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}|{{.Architecture}}|{{json .RepoDigests}}",
      NGINX_IMAGE,
    ]),
    "read pinned nginx identity",
  ).stdout.trim();
  const [imageId, architecture, ...digestParts] = identity.split("|");
  const repoDigests = JSON.parse(digestParts.join("|"));
  assert.ok(repoDigests.includes(NGINX_IMAGE), "resolved nginx image omitted the pinned index digest");
  return { imageId, architecture, repoDigests };
};

const main = async () => {
  const cleanup = new CleanupStack();
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const imageTag = `ferrite-nginx-proof-${suffix}:candidate`;
  const networkName = `ferrite-nginx-proof-${suffix}`;
  const ferriteContainer = `ferrite-proof-${suffix}`;
  const nginxContainer = `nginx-proof-${suffix}`;
  const missingCertCheck = `nginx-proof-missing-cert-${suffix}`;
  const configCheck = `nginx-proof-config-${suffix}`;
  const scratchParent = join(repositoryRoot, ".ferrite");
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, "nginx-proof-"));
  const certificateDirectory = join(scratch, "certificate");
  const missingCertificateDirectory = join(scratch, "missing-certificate");
  const nginxConfigPath = join(scratch, "default.conf");
  const accessLogPath = join(scratch, "ferrite.log");
  await mkdir(certificateDirectory);
  await mkdir(missingCertificateDirectory);
  await writeFile(accessLogPath, "");

  let interruptedSignal;
  const interrupt = (signal) => {
    interruptedSignal = signal;
    for (const child of activeChildren) child.kill("SIGTERM");
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let primaryError;
  let proofComplete = false;
  let cleanupErrors = [];
  try {
    const commit = assertCommandSucceeded(
      await runCommand("git", ["rev-parse", "HEAD"]),
      "read source commit",
    ).stdout.trim();
    const tree = assertCommandSucceeded(
      await runCommand("git", ["rev-parse", "HEAD^{tree}"]),
      "read source tree",
    ).stdout.trim();
    const status = assertCommandSucceeded(
      await runCommand("git", ["status", "--porcelain", "--untracked-files=all"]),
      "read source status",
    ).stdout;
    const sourceClean = status.length === 0;
    process.stdout.write(
      `${JSON.stringify({ sourceCommit: commit, sourceTree: tree, sourceClean, scratch })}\n`,
    );

    assertCommandSucceeded(
      await runCommand("docker", ["version", "--format", "{{.Server.Version}}"]),
      "connect to Docker daemon",
    );

    const template = await readFile(join(repositoryRoot, "deploy/nginx/ferrite.conf"), "utf8");
    await writeFile(nginxConfigPath, renderProofNginxConfig(template));
    assertCommandSucceeded(
      await runCommand("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=app.example.com",
        "-addext",
        "subjectAltName=DNS:app.example.com",
        "-keyout",
        join(certificateDirectory, "privkey.pem"),
        "-out",
        join(certificateDirectory, "fullchain.pem"),
      ]),
      "generate ephemeral TLS certificate",
    );

    const nginxIdentity = await ensurePinnedNginxImage();
    process.stdout.write(`${JSON.stringify({ nginxImage: NGINX_IMAGE, ...nginxIdentity })}\n`);

    cleanup.defer("candidate image cleanup", () => removeDockerResource("image", imageTag));
    process.stdout.write("Building exact Ferrite candidate image\n");
    assertCommandSucceeded(
      await runCommand(
        "docker",
        [
          "build",
          "--file",
          "deploy/container/Dockerfile",
          "--label",
          `org.opencontainers.image.revision=${commit}`,
          "--label",
          `io.ferrite.source-clean=${sourceClean}`,
          "--tag",
          imageTag,
          ".",
        ],
        { timeoutMs: 1_200_000, stream: true },
      ),
      "build Ferrite candidate image",
    );
    const candidateIdentity = assertCommandSucceeded(
      await runCommand("docker", [
        "image",
        "inspect",
        "--format",
        '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.ferrite.source-clean"}}',
        imageTag,
      ]),
      "inspect Ferrite candidate image",
    ).stdout.trim();
    const [candidateImageId, candidateRevision, candidateClean] = candidateIdentity.split("|");
    assert.equal(candidateRevision, commit, "candidate image revision label did not match HEAD");
    assert.equal(candidateClean, String(sourceClean), "candidate image clean-state label was wrong");
    process.stdout.write(
      `${JSON.stringify({ candidateImageId, candidateRevision, candidateClean })}\n`,
    );

    cleanup.defer("proof network cleanup", () => removeDockerResource("network", networkName));
    assertCommandSucceeded(
      await runCommand("docker", ["network", "create", networkName]),
      "create isolated proof network",
    );

    cleanup.defer("Ferrite container cleanup", () =>
      removeDockerResource("container", ferriteContainer),
    );
    assertCommandSucceeded(
      await runCommand("docker", [
        "run",
        "--detach",
        "--name",
        ferriteContainer,
        "--network",
        networkName,
        "--network-alias",
        "ferrite-upstream",
        imageTag,
        "ferrite",
        "serve",
        "--project",
        "/srv/ferrite/app",
        "--artifact",
        ".ferrite/build",
        "--page-renderer",
        "/srv/ferrite/render-artifact.mjs",
        "--host",
        "0.0.0.0",
        "--port",
        "3000",
        "--render-timeout-ms",
        "30000",
        "--request-read-timeout-ms",
        "5000",
        "--response-write-timeout-ms",
        "5000",
        "--max-request-bytes",
        "16384",
        "--max-in-flight-requests",
        "64",
        "--trusted-proxy-public-origin",
        "https://app.example.com",
        "--trusted-proxy-client-ip-hops",
        "1",
        "--access-log",
        "json",
        "--action-log",
        "json",
      ]),
      "start Ferrite proof container",
    );
    const logFollower = await startDockerLogFollower(ferriteContainer, accessLogPath);
    cleanup.defer("Ferrite log follower cleanup", () => logFollower.stop());
    await waitForFerrite(ferriteContainer);

    const commonNginxMounts = [
      "--volume",
      `${nginxConfigPath}:/etc/nginx/conf.d/default.conf:ro`,
    ];
    cleanup.defer("missing-certificate check cleanup", () =>
      removeDockerResource("container", missingCertCheck),
    );
    const missingCertificateResult = await runCommand("docker", [
      "run",
      "--rm",
      "--name",
      missingCertCheck,
      "--network",
      networkName,
      ...commonNginxMounts,
      "--volume",
      `${missingCertificateDirectory}:/etc/letsencrypt/live/app.example.com:ro`,
      NGINX_IMAGE,
      "nginx",
      "-t",
    ]);
    assertExpectedFailure(
      missingCertificateResult,
      "nginx missing-certificate control",
      /cannot load certificate|BIO_new_file\(\) failed|No such file/i,
    );
    process.stdout.write("negative control passed: nginx rejects missing TLS material\n");

    cleanup.defer("nginx config-check cleanup", () =>
      removeDockerResource("container", configCheck),
    );
    assertCommandSucceeded(
      await runCommand("docker", [
        "run",
        "--rm",
        "--name",
        configCheck,
        "--network",
        networkName,
        ...commonNginxMounts,
        "--volume",
        `${certificateDirectory}:/etc/letsencrypt/live/app.example.com:ro`,
        NGINX_IMAGE,
        "nginx",
        "-t",
      ]),
      "validate generated nginx configuration",
    );

    cleanup.defer("nginx container cleanup", () =>
      removeDockerResource("container", nginxContainer),
    );
    assertCommandSucceeded(
      await runCommand("docker", [
        "run",
        "--detach",
        "--name",
        nginxContainer,
        "--network",
        networkName,
        "--publish",
        "127.0.0.1::443",
        ...commonNginxMounts,
        "--volume",
        `${certificateDirectory}:/etc/letsencrypt/live/app.example.com:ro`,
        NGINX_IMAGE,
      ]),
      "start nginx proof container",
    );
    const publishedPort = parseDockerPublishedPort(
      assertCommandSucceeded(
        await runCommand("docker", ["port", nginxContainer, "443/tcp"]),
        "read nginx published port",
      ).stdout,
    );
    await waitForNginxTls(publishedPort);

    const environment = verifierEnvironment({ port: publishedPort, accessLogPath });
    const successfulLogOffset = (await stat(accessLogPath)).size;
    const successful = assertCommandSucceeded(
      await runVerifier(environment, { stream: true }),
      "run 25-case nginx framing matrix",
    );
    assert.match(successful.stdout, /nginx framing matrix passed: 25\/25/);

    const secureEnvironment = { ...environment };
    delete secureEnvironment.FERRITE_NGINX_INSECURE;
    assertExpectedFailure(
      await runVerifier(secureEnvironment),
      "self-signed TLS verification control",
      /self[- ]signed|certificate|DEPTH_ZERO_SELF_SIGNED_CERT/i,
    );
    process.stdout.write("negative control passed: TLS verification defaults to fail closed\n");

    const missingLogEnvironment = { ...environment };
    delete missingLogEnvironment.FERRITE_NGINX_ACCESS_LOG_PATH;
    assertExpectedFailure(
      await runVerifier(missingLogEnvironment),
      "missing access-log control",
      /must point to the running Ferrite --access-log json output/,
    );
    process.stdout.write("negative control passed: access-log evidence is mandatory\n");

    assertExpectedFailure(
      await runVerifier({ ...environment, FERRITE_NGINX_MAX_RESPONSE_BYTES: "100" }),
      "response-size control",
      /response exceeded 100 bytes/,
    );
    process.stdout.write("negative control passed: verifier response cap fails closed\n");

    await runStalledTlsDeadlineControl(environment);
    process.stdout.write("negative control passed: verifier deadline aborts a stalled TLS peer\n");

    const successfulLog = (await readFile(accessLogPath)).subarray(successfulLogOffset).toString("utf8");
    const successfulEntries = parseAccessLogEntries(successfulLog);
    const canaryPaths = [
      "/posts/nginx-smuggle-duplicate-content-length",
      "/posts/nginx-smuggle-conflicting-content-length",
      "/posts/nginx-smuggle-comma-content-length",
      "/posts/nginx-smuggle-transfer-encoding-content-length",
      "/posts/nginx-smuggle-duplicate-transfer-encoding",
    ];
    assertNginxAccessLogEvidence(successfulEntries, canaryPaths);
    assert.throws(
      () =>
        assertNginxAccessLogEvidence(
          [
            ...successfulEntries,
            {
              method: "GET",
              path: canaryPaths[0],
              status: 200,
              route_pattern: "/posts/:id",
              client_ip: "127.0.0.1",
              elapsed_ms: 0,
            },
          ],
          canaryPaths,
        ),
      /smuggling canary reached Ferrite/,
    );
    process.stdout.write("negative control passed: synthetic upstream canary is rejected\n");

    if (logFollower.child.exitCode !== null) {
      throw new Error(`Ferrite log follower exited early with ${logFollower.child.exitCode}`);
    }
    proofComplete = true;
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupErrors = await cleanup.run();
    await rm(scratch, { recursive: true, force: true });
    const scratchStillExists = await access(scratch).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (scratchStillExists) cleanupErrors.push(new Error(`scratch directory remains: ${scratch}`));
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  if (interruptedSignal && !primaryError) {
    primaryError = new Error(`nginx proof interrupted by ${interruptedSignal}`);
  }
  if (cleanupErrors.length > 0) {
    const cleanupFailure = new AggregateError(cleanupErrors, "nginx proof cleanup failed");
    primaryError = primaryError
      ? new AggregateError([primaryError, cleanupFailure], "nginx proof and cleanup failed")
      : cleanupFailure;
  } else {
    process.stdout.write(
      "cleanup verified: owned containers, network, image tag, log follower, and scratch removed\n",
    );
  }
  if (primaryError) throw primaryError;
  assert.ok(proofComplete, "nginx proof exited without completing the matrix");
  process.stdout.write("nginx stack proof passed\n");
};

const isMain =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
