import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { connect as connectHttp2 } from "node:http2";
import tls from "node:tls";
import { URLSearchParams } from "node:url";
import {
  assertNginxAccessLogEvidence,
  NGINX_FRAMING_PROBE_NAMES,
  nginxFramingProbeTarget,
  nginxRequestTargetRejectionProbes,
  parseAccessLogEntries,
} from "./lib/nginx-access-log.mjs";

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

const exchangeHttp2 = ({
  method = "GET",
  path = "/posts/abc",
  authority = servername,
  headers = {},
  body = Buffer.alloc(0),
} = {}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let responseStatus;
    let responseBytes = 0;
    const chunks = [];
    const session = connectHttp2(`https://${host}:${port}`, {
      servername,
      rejectUnauthorized,
      ALPNProtocols: ["h2"],
    });
    const deadline = setTimeout(() => {
      settle(reject, new Error(`nginx HTTP/2 exchange timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (callback, value, { destroySession = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (destroySession) session.destroy();
      callback(value);
    };
    session.once("error", (error) => settle(reject, error));
    session.once("connect", () => {
      if (settled) return;
      if (session.socket.alpnProtocol !== "h2") {
        settle(
          reject,
          new Error(
            `nginx negotiated unexpected HTTP/2 ALPN protocol: ${session.socket.alpnProtocol || "none"}`,
          ),
        );
        return;
      }
      let stream;
      try {
        stream = session.request(
          {
            ":method": method,
            ":path": path,
            ":scheme": "https",
            ":authority": authority,
            ...headers,
          },
          { endStream: false },
        );
      } catch (error) {
        settle(reject, error);
        return;
      }
      stream.once("response", (responseHeaders) => {
        responseStatus = Number(responseHeaders[":status"]);
      });
      stream.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > maxResponseBytes) {
          stream.close();
          settle(
            reject,
            new Error(`nginx HTTP/2 response exceeded ${maxResponseBytes} bytes`),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", (error) => settle(reject, error));
      stream.once("end", () => {
        if (!Number.isInteger(responseStatus)) {
          settle(reject, new Error("nginx HTTP/2 response omitted :status"));
          return;
        }
        const response = { status: responseStatus, body: Buffer.concat(chunks) };
        session.close(() => settle(resolve, response, { destroySession: false }));
      });
      stream.end(body);
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

const actionBodyFor = (route, title) =>
  Buffer.from(
    new URLSearchParams({
      __ferrite_action: "app/posts/[id]/page.tsx#savePost",
      __ferrite_route: route,
      title,
    }).toString(),
  );
const actionBody = actionBodyFor("/posts/abc", "nginx framing proof");
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
const smugglingCanaryPaths = NGINX_FRAMING_PROBE_NAMES.map(
  (name) => `/posts/nginx-smuggle-${name}`,
);
const framingProbeTargets = NGINX_FRAMING_PROBE_NAMES.map(nginxFramingProbeTarget);
const requestTargetRejectionProbes = nginxRequestTargetRejectionProbes(servername);
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
        target: framingProbeTargets[0],
        headers: [
          ...actionHeaders,
          `Content-Length: ${actionBody.length}`,
          `content-length: ${actionBody.length}`,
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
        target: framingProbeTargets[1],
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
        target: framingProbeTargets[2],
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
        target: framingProbeTargets[3],
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
        target: framingProbeTargets[4],
        headers: [
          ...actionHeaders,
          "Transfer-Encoding: chunked",
          "transfer-encoding:",
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
      `GET /posts/abc HTTP/1.1\r\nHost: ${servername}\r\nhOsT: evil.example\r\nConnection: close\r\n\r\n`,
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
    name: "mixed-case canonical HTTPS target",
    payload: request({ target: "HtTpS://App.Example.Com/posts/abc" }),
    statuses: [200],
    includes: ["Post abc"],
  },
  {
    name: "FTP absolute-form target rejection",
    payload: request({ target: `FtP://${servername}/posts/abc` }),
    statuses: [421],
  },
  {
    name: "WebSocket absolute-form target rejection",
    payload: request({ target: `wS://${servername}/posts/abc` }),
    statuses: [421],
  },
  {
    name: "Gopher absolute-form target rejection",
    payload: request({ target: `GoPhEr://${servername}/posts/abc` }),
    statuses: [421],
  },
  {
    name: "encoded slash target rejection",
    payload: request({ target: "/posts/%2fadmin" }),
    statuses: [421],
  },
  {
    name: "encoded dot-segment target rejection",
    payload: request({ target: "/posts/%2e%2e/abc" }),
    statuses: [421],
  },
  {
    name: "encoded backslash target rejection",
    payload: request({ target: "/posts/%5cadmin" }),
    statuses: [421],
  },
  ...requestTargetRejectionProbes.map((probe) => ({
    name: `${probe.name} rejection`,
    payload: request({ target: probe.target }),
    statuses: [421],
  })),
  {
    name: "literal parent-segment target rejection",
    payload: request({ target: "/posts/../abc" }),
    statuses: [421],
  },
  {
    name: "literal current-segment target rejection",
    payload: request({ target: "/./posts/abc" }),
    statuses: [421],
  },
  {
    name: "network-path target rejection",
    payload: request({ target: "//evil.example/posts/abc" }),
    statuses: [421],
  },
  {
    name: "bare authority target rejection",
    payload: request({ target: "evil.example/posts/abc" }),
    statuses: [400],
  },
  {
    name: "mixed-case absolute-form authority mismatch",
    payload: request({ target: "HtTpS://evil.example/posts/abc" }),
    statuses: [421],
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

const http2Cases = [
  {
    name: "HTTP/2 normal GET",
    request: { path: "/posts/h2-normal" },
    status: 200,
    includes: ["Post h2-normal"],
  },
  {
    name: "HTTP/2 DATA-frame action without client Content-Length",
    request: {
      method: "POST",
      path: "/_ferrite/action",
      headers: {
        origin: `https://${servername}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: actionBodyFor("/posts/h2-data", "nginx HTTP/2 DATA proof"),
    },
    status: 200,
    includes: ['"status":"ok"'],
  },
  {
    name: "HTTP/2 authority mismatch",
    request: { authority: "evil.example" },
    status: 421,
  },
  {
    name: "HTTP/2 forwarded-header spoof overwrite",
    request: {
      method: "POST",
      path: "/_ferrite/action",
      headers: {
        origin: `https://${servername}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "203.0.113.99",
      },
      body: actionBodyFor("/posts/h2-spoof", "nginx HTTP/2 spoof proof"),
    },
    status: 200,
    includes: ['"status":"ok"'],
  },
];

for (const testCase of http2Cases) {
  const response = await exchangeHttp2(testCase.request);
  const responseText = response.body.toString("utf8");
  assert.equal(response.status, testCase.status, `${testCase.name}: unexpected response status`);
  for (const expected of testCase.includes ?? []) {
    assert.ok(responseText.includes(expected), `${testCase.name}: response omitted ${expected}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      case: testCase.name,
      status: response.status,
      bytes: response.body.length,
      ok: true,
    })}\n`,
  );
}

const waitForAccessLog = async () => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = (await readFile(accessLogPath)).subarray(accessLogOffset).toString("utf8");
    const entries = parseAccessLogEntries(log);
    const paths = new Set(entries.map((entry) => entry.path));
    const actionRoutes = new Set(entries.map((entry) => entry.route_path));
    if (
      paths.has("/posts/abc") &&
      paths.has("/posts/h2-normal") &&
      paths.has("/_ferrite/action") &&
      actionRoutes.has("/posts/h2-data") &&
      actionRoutes.has("/posts/h2-spoof")
    ) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Ferrite access log did not record baseline requests within ${timeoutMs} ms`);
};
const accessLogEntries = await waitForAccessLog();
assertNginxAccessLogEvidence(accessLogEntries, smugglingCanaryPaths, {
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
});

process.stdout.write(`nginx framing matrix passed: ${cases.length}/${cases.length}\n`);
process.stdout.write(`nginx HTTP/2 matrix passed: ${http2Cases.length}/${http2Cases.length}\n`);
