# Milestone 087: Production Metrics Endpoint

## Scope

- Added `ferrite serve --metrics-path <absolute-path>`.
- Added an opt-in production metrics endpoint that returns Prometheus text counters for request and server-action outcomes.
- Updated deployment templates, deployment docs, architecture docs, README, GTM plan, and the productionization checklist.

## Proof

- Production route metrics are recorded from real `ProductionProject::handle_get` responses and label by method, status, and route pattern.
- Production action metrics are recorded from real `ProductionProject::handle_post` server-action responses and label by accepted/rejected outcome, status, and route pattern.
- Metrics output intentionally excludes headers, bodies, form fields, CSRF tokens, action ids, and raw dynamic URL values.
- CLI validation rejects relative metrics paths, query strings/fragments, and `/_ferrite/action` shadowing.
- Deployment template verification now requires `--metrics-path /__ferrite/metrics` in systemd and container templates.

## Not Proven

- No hosted staging scrape was run because this checkout still has no configured Git remote or hosted deployment target.
- No external metrics sink, tracing backend, or external audit exporter was configured.
- Metrics are in-memory per process; multi-process aggregation remains an operator concern until an external sink exists.
