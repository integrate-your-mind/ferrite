# Milestone 093 Proof

## Scope

Bound every production HTTP response write without weakening fixed-body, compressed, chunked, overload, or graceful-shutdown behavior.

## Contract

- `ProductionServerConfig::response_write_timeout` defaults to 5 seconds and clamps to a 1 ms minimum.
- `ferrite serve --response-write-timeout-ms` configures the same value and reports the effective value in text and JSON startup/one-shot output.
- The timeout is an absolute whole-response budget. Before every low-level write, Ferrite subtracts elapsed time and applies the remaining duration to the socket operation.
- Headers, fixed bodies, gzip bodies, streamed chunks, parse-error responses, and the terminating chunk share one deadline.
- Worker-pool overload responses use the smaller of the configured timeout and 100 ms.
- Graceful shutdown drains accepted work through the same bounded writer.

If a deadline expires after bytes have been sent, Ferrite closes the connection. It does not attempt to append or replace the partial response with another HTTP status. The concurrent production server emits a generic timeout message to stderr without request headers or body data.

## Local Proof

- Config tests cover defaults and zero-value clamping.
- CLI tests cover flag parsing and effective limit conversion; the text and JSON output branches compile with the effective field.
- Existing real-socket tests continue to prove fixed-body, gzip, chunked, parse-error, overload `503`, and shutdown-drain responses.
- A deterministic real-socket writer test lets one write succeed, waits beyond the configured budget, and proves the next write returns the typed deadline error without resetting the timer or sending more bytes.
- A real TCP test sends a valid request, does not consume a 64 MiB response, configures a 50 ms write deadline, and receives a typed `TimedOut` server result containing only the generic deadline message.
- A concurrent-server test begins a 64 MiB verified-asset response, requests graceful shutdown without consuming the response, and proves worker drain finishes through the write deadline with a truncated body.
- Deployment-template verification requires `--response-write-timeout-ms 5000` in both container and systemd commands.

## Explicitly Not Proven

- Sustained concurrent slow-reader capacity or soak behavior.
- Dedicated timeout-exhaustion tests for every small response class; shared writer wiring plus successful fixed, gzip, chunked, parse-error, and overload tests provide the current coverage.
- Hosted proxy/CDN behavior when upstream responses are truncated.
- Artifact-runner crash recovery or multi-instance failover.
- Remote CI or hosted deployment proof; this checkout still has no Git remote.
