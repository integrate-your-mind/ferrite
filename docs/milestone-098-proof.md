# Milestone 098: Bounded mixed-load soak

## Outcome

Ferrite now has an artifact-backed real-socket soak that repeatedly combines concurrent slow readers, overload rejection, normal load, one runner-process failure, and post-saturation recovery under explicit deadlines.

## Production fix

The soak exposed a race where an overloaded socket could be accepted before the client sent its request bytes. Closing that socket with unread data could reset the connection and discard the intended `503`. Overload handling now uses at most four dedicated rejection workers and a bounded queue, keeping the accept loop responsive. A rejection worker writes the bounded `503`, half-closes output, and drains at most 25 ms under one absolute budget before closing input. Queue overflow uses a nonblocking best-effort rejection and drains only bytes already available. Delayed-send, trickle-input, and 32-client silent-overload regressions lock in delivery and bounds without false `408` responses.

## Soak invariants

- Four admitted slow readers fill all workers across three waves.
- Every slow response starts as `200` but is truncated by the absolute write deadline.
- Twenty-four concurrent overload clients receive complete `503` responses with `no-store` caching.
- Ten barrier-synchronized eight-client mixed-load waves return only `200` or `503`; complete requests never receive `408`.
- A synthetic runner exit after the saturation waves returns a redacted `500`, and subsequent requests recover to `200`.
- Runner lifecycle starts equal completions plus the one intentional failure.
- Overload rejection resources remain fixed, final sequential requests succeed, and shutdown joins all request and rejection workers within its bound.

## Proof completed before the full repository gate

- The integrated soak passed ten consecutive non-instrumented repetitions.
- The final bounded-pool soak passed ten consecutive repetitions; earlier iterations also exposed and removed timing assumptions.
- Final full-suite and coverage totals are recorded in the exact-SHA receipt.

## Boundary

This is deterministic bounded regression proof. It does not claim hosted throughput, percentile latency, long-duration capacity, multi-instance behavior, publication, deployment, or release.
