# Milestone 095 Proof

## Scope

Prove that the artifact-backed worker pool preserves a bounded overload response, recovers capacity after saturation, and remains usable after an artifact-runner subprocess failure.

## Runtime Fix

Ferrite previously wrote overload `503` responses and immediately dropped sockets whose request bytes had not been consumed. On macOS, the real-socket saturation test reproduced `ConnectionReset`, which could discard the rejection response. Rejected sockets now shut down the read side before the bounded `503` write and shut down the write side afterward.

The stress run also exposed false `408 Request Timeout` responses when a worker read an accepted socket before its request bytes arrived. The listener is nonblocking, and accepted sockets can preserve that mode; `WouldBlock` was then handled like a real read deadline. Worker-pool admission now clears nonblocking mode before capacity selection or request handling.

## Local Proof

- Both tests load and verify a minimal production artifact, retain its module bytes, delete the artifact directory, and execute a custom runner through `--prebuilt-stdin`.
- The saturation test blocks two artifact-runner subprocesses at a filesystem barrier with `max_in_flight_requests = 2`.
- Six additional real TCP requests each receive `503 Service Unavailable` with `Cache-Control: no-store` in under two seconds for the wave.
- After the barrier is released, both held requests complete with `200`, and a later request also completes with `200`.
- The saturation/recovery and runner-failure recovery tests pass together for 50 consecutive executions after the overload close and inherited-nonblocking fixes.
- The failure-recovery test uses one worker, makes the first artifact-runner subprocess exit with status 17, verifies a generic public `500` without stderr disclosure, and proves the next request returns `200` from a fresh runner subprocess on the same worker.
- `cargo llvm-cov -p ferrite-dev-server --summary-only -- --test-threads=1` through the rustup stable toolchain reports 90.12% line, 90.20% function, and 89.58% region coverage for the 90-test server suite.

## Explicitly Not Proven

- This controlled wave is a deterministic regression, not a throughput, latency, capacity, or soak benchmark.
- Concurrent slow-reader load remains unproven beyond the single-client response-deadline and shutdown-drain tests.
- Host-process supervisor restart, multi-instance recovery, hosted proxy behavior, and rollback under live traffic remain unproven.
- No committed coverage threshold, workspace-wide JavaScript/Rust branch report, or mutation-testing gate exists.
- Remote CI remains unavailable because this checkout has no Git remote.
