import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import tls from "node:tls";
import { URLSearchParams } from "node:url";

const host = process.env.FERRITE_NGINX_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.FERRITE_NGINX_PORT ?? "8443", 10);
const servername = process.env.FERRITE_NGINX_SERVER_NAME ?? "app.example.com";
const rejectUnauthorized = process.env.FERRITE_NGINX_INSECURE !== "1";
const timeoutMs = Number.parseInt(process.env.FERRITE_NGINX_TIMEOUT_MS ?? "5000", 10);
const maxResponseBytes = Number.parseInt(
  process.env.FERRITE_NGINX_MAX_RESPONSE_BYTES ?? "2097152",
  10,
);
const accessLogPath = process.env.FERRITE_NGINX_ACCESS_LOG_PATH;

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("FERRITE_NGINX_PORT must be an integer from 1 through 65535");
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error("FERRITE_NGINX_TIMEOUT_MS must be a positive integer");
}
if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
  throw new Error("FERRITE_NGINX_MAX_RESPONSE_BYTES must be a positive integer");
}
if (!accessLogPath) {
  throw new Error(
    "FERRITE_NGINX_ACCESS_LOG_PATH must point to the running Ferrite --access-log json output",
  );
}

const accessLogOffset = await stat(accessLogPath)
  .then((metadata) => metadata.size)
  .catch((error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });

process.stdout.write(
  `${JSON.stringify({
    target: `${host}:${port}`,
    servername,
    tlsVerification: rejectUnauthorized ? "required" : "disabled-for-local-proof",
    timeoutMs,
    maxResponseBytes,
    accessLogPath,
  })}\n`,
);

const exchange = (payload) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let responseBytes = 0;
    let settled = false;
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized,
      ALPNProtocols: ["http/1.1"],
    });
    const deadline = setTimeout(() => {
      socket.destroy(new Error(`nginx TLS exchange timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    socket.on("data", (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes > maxResponseBytes) {
        socket.destroy(new Error(`nginx TLS response exceeded ${maxResponseBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", (error) => settle(reject, error));
    socket.once("end", () => settle(resolve, Buffer.concat(chunks)));
    socket.once("close", (hadError) => {
      if (!hadError) {
        settle(reject, new Error("nginx TLS connection closed before a complete response"));
      }
    });
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== "http/1.1") {
        socket.destroy(
          new Error(`nginx negotiated unexpected ALPN protocol: ${socket.alpnProtocol || "none"}`),
        );
        return;
      }
      socket.write(payload);
    });
  });

const request = ({
  method = "GET",
  target = "/posts/abc",
  headers = [],
  body = Buffer.alloc(0),
  version = "HTTP/1.1",
  eol = "\r\n",
  connection = "close",
} = {}) =>
  Buffer.concat([
    Buffer.from(
      [
        `${method} ${target} ${version}`,
        `Host: ${servername}`,
        ...headers,
        `Connection: ${connection}`,
        "",
        "",
      ].join(eol),
    ),
    body,
  ]);

const actionBody = Buffer.from(
  new URLSearchParams({
    __ferrite_action: "app/posts/[id]/page.tsx#savePost",
    __ferrite_route: "/posts/abc",
    title: "nginx framing proof",
  }).toString(),
);
const actionHeaders = [
  `Origin: https://${servername}`,
  "Content-Type: application/x-www-form-urlencoded",
];
const action = (extraHeaders = []) =>
  request({
    method: "POST",
    target: "/_ferrite/action",
    headers: [...actionHeaders, ...extraHeaders, `Content-Length: ${actionBody.length}`],
    body: actionBody,
  });
const chunkedActionBody = Buffer.concat([
  Buffer.from(`${actionBody.length.toString(16)}\r\n`),
  actionBody,
  Buffer.from("\r\n0\r\n\r\n"),
]);
const smugglingCanaryPaths = [
  "/posts/nginx-smuggle-duplicate-content-length",
  "/posts/nginx-smuggle-conflicting-content-length",
  "/posts/nginx-smuggle-comma-content-length",
  "/posts/nginx-smuggle-transfer-encoding-content-length",
  "/posts/nginx-smuggle-duplicate-transfer-encoding",
];
const smugglingSuffix = (path) =>
  Buffer.from(
    `GET ${path} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`,
  );

const cases = [
  {
    name: "normal GET",
    payload: request(),
    statuses: [200],
    includes: ["Post abc"],
  },
  {
    name: "Content-Length action",
    payload: action(),
    statuses: [200],
    includes: ['"status":"ok"'],
  },
  {
    name: "chunked client action",
    payload: request({
      method: "POST",
      target: "/_ferrite/action",
      headers: [...actionHeaders, "Transfer-Encoding: chunked"],
      body: chunkedActionBody,
    }),
    statuses: [200],
    includes: ['"status":"ok"'],
  },
  {
    name: "duplicate identical Content-Length",
    payload: Buffer.concat([
      request({
        method: "POST",
        target: "/_ferrite/action",
        headers: [
          ...actionHeaders,
          `Content-Length: ${actionBody.length}`,
          `Content-Length: ${actionBody.length}`,
        ],
        body: actionBody,
        connection: "keep-alive",
      }),
      smugglingSuffix(smugglingCanaryPaths[0]),
    ]),
    statuses: [400],
  },
  {
    name: "duplicate conflicting Content-Length",
    payload: Buffer.concat([
      request({
        method: "POST",
        target: "/_ferrite/action",
        headers: [...actionHeaders, "Content-Length: 1", `Content-Length: ${actionBody.length}`],
        body: actionBody,
        connection: "keep-alive",
      }),
      smugglingSuffix(smugglingCanaryPaths[1]),
    ]),
    statuses: [400],
  },
  {
    name: "comma Content-Length",
    payload: Buffer.concat([
      request({
        method: "POST",
        target: "/_ferrite/action",
        headers: [
          ...actionHeaders,
          `Content-Length: ${actionBody.length}, ${actionBody.length}`,
        ],
        body: actionBody,
        connection: "keep-alive",
      }),
      smugglingSuffix(smugglingCanaryPaths[2]),
    ]),
    statuses: [400],
  },
  {
    name: "Transfer-Encoding plus Content-Length",
    payload: Buffer.concat([
      request({
        method: "POST",
        target: "/_ferrite/action",
        headers: [
          ...actionHeaders,
          "Transfer-Encoding: chunked",
          `Content-Length: ${actionBody.length}`,
        ],
        body: chunkedActionBody,
        connection: "keep-alive",
      }),
      smugglingSuffix(smugglingCanaryPaths[3]),
    ]),
    statuses: [400],
  },
  {
    name: "duplicate Transfer-Encoding with empty final value",
    payload: Buffer.concat([
      request({
        method: "POST",
        target: "/_ferrite/action",
        headers: [
          ...actionHeaders,
          "Transfer-Encoding: chunked",
          "Transfer-Encoding:",
          `Content-Length: ${actionBody.length}`,
        ],
        body: chunkedActionBody,
        connection: "keep-alive",
      }),
      smugglingSuffix(smugglingCanaryPaths[4]),
    ]),
    statuses: [400],
  },
  {
    name: "duplicate Host",
    payload: Buffer.from(
      `GET /posts/abc HTTP/1.1\r\nHost: ${servername}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    ),
    statuses: [400],
  },
  {
    name: "duplicate Origin",
    payload: action(["Origin: https://evil.example"]),
    statuses: [400],
    includes: ["duplicate origin"],
  },
  {
    name: "duplicate Referer",
    payload: action([
      `Referer: https://${servername}/posts/abc`,
      "Referer: https://evil.example/posts/abc",
    ]),
    statuses: [400],
    includes: ["duplicate referer"],
  },
  {
    name: "duplicate Cookie",
    payload: request({ headers: ["Cookie: session=one", "Cookie: session=two"] }),
    statuses: [400],
    includes: ["duplicate cookie"],
  },
  {
    name: "whitespace before colon",
    payload: Buffer.from(
      `GET /posts/abc HTTP/1.1\r\nHost : ${servername}\r\nConnection: close\r\n\r\n`,
    ),
    statuses: [400],
  },
  {
    name: "obsolete folded header",
    payload: Buffer.from(
      `GET /posts/abc HTTP/1.1\r\nHost: ${servername}\r\nX-Test: one\r\n two\r\nConnection: close\r\n\r\n`,
    ),
    statuses: [400],
  },
  {
    name: "absolute-form target canonicalization",
    payload: request({ target: `https://${servername}/posts/abc` }),
    statuses: [200],
    includes: ["Post abc"],
  },
  {
    name: "absolute-form authority mismatch",
    payload: request({ target: "https://evil.example/posts/abc" }),
    statuses: [421],
  },
  {
    name: "absolute-form port rejection",
    payload: request({ target: `https://${servername}:81/posts/abc` }),
    statuses: [421],
  },
  {
    name: "unknown Host authority",
    payload: Buffer.from(
      "GET /posts/abc HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    ),
    statuses: [421],
  },
  {
    name: "raw Host port rejection",
    payload: Buffer.from(
      `GET /posts/abc HTTP/1.1\r\nHost: ${servername}:http\r\nConnection: close\r\n\r\n`,
    ),
    statuses: [421],
  },
  {
    name: "invalid bracketed IPv6 authority",
    payload: Buffer.from(
      "GET /posts/abc HTTP/1.1\r\nHost: [::1\r\nConnection: close\r\n\r\n",
    ),
    statuses: [421],
  },
  {
    name: "HTTP/1.0 edge canonicalization",
    payload: request({ version: "HTTP/1.0" }),
    statuses: [200],
    includes: ["Post abc"],
  },
  {
    name: "bare-LF edge canonicalization",
    payload: request({ eol: "\n" }),
    statuses: [200],
    includes: ["Post abc"],
  },
  {
    name: "Expect action",
    payload: request({
      method: "POST",
      target: "/_ferrite/action",
      headers: [...actionHeaders, "Expect: 100-continue", `Content-Length: ${actionBody.length}`],
      body: actionBody,
    }),
    statuses: [100, 200],
    includes: ['"status":"ok"'],
  },
  {
    name: "spoofed forwarded headers",
    payload: action([
      "X-Forwarded-Proto: http",
      "X-Forwarded-Proto: ftp",
      "X-Forwarded-Host: evil.example",
      "X-Forwarded-Host: other.example",
    ]),
    statuses: [200],
    includes: ['"status":"ok"'],
  },
  {
    name: "two pipelined client requests",
    payload: Buffer.from(
      `GET /posts/abc HTTP/1.1\r\nHost: ${servername}\r\nConnection: keep-alive\r\n\r\n` +
        `GET /posts/def HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`,
    ),
    statuses: [200, 200],
    includes: ["Post abc", "Post def"],
  },
];

for (const testCase of cases) {
  const response = await exchange(testCase.payload);
  const responseText = response.toString("utf8");
  const statuses = [...responseText.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((match) =>
    Number.parseInt(match[1], 10),
  );
  assert.deepEqual(statuses, testCase.statuses, `${testCase.name}: unexpected response statuses`);
  for (const expected of testCase.includes ?? []) {
    assert.ok(responseText.includes(expected), `${testCase.name}: response omitted ${expected}`);
  }
  process.stdout.write(
    `${JSON.stringify({ case: testCase.name, statuses, bytes: response.length, ok: true })}\n`,
  );
}

const parseAccessLogEntries = (log) =>
  log.split(/\r?\n/).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === "object" ? [entry] : [];
    } catch {
      return [];
    }
  });
const waitForAccessLog = async () => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = (await readFile(accessLogPath)).subarray(accessLogOffset).toString("utf8");
    const entries = parseAccessLogEntries(log);
    const paths = new Set(entries.map((entry) => entry.path));
    if (paths.has("/posts/abc") && paths.has("/_ferrite/action")) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Ferrite access log did not record baseline requests within ${timeoutMs} ms`);
};
const accessLogEntries = await waitForAccessLog();
const accessLogPaths = new Set(accessLogEntries.map((entry) => entry.path));
assert.ok(accessLogPaths.has("/posts/abc"), "Ferrite access log omitted the baseline route");
assert.ok(accessLogPaths.has("/_ferrite/action"), "Ferrite access log omitted the baseline action");
assert.ok(
  accessLogEntries.some(
    (entry) => entry.path === "/_ferrite/action" && typeof entry.client_ip === "string",
  ),
  "Ferrite access log did not prove trusted-proxy client-IP policy",
);
for (const canaryPath of smugglingCanaryPaths) {
  assert.ok(
    !accessLogPaths.has(canaryPath),
    `smuggling canary reached Ferrite: ${canaryPath}`,
  );
}

process.stdout.write(`nginx framing matrix passed: ${cases.length}/${cases.length}\n`);
