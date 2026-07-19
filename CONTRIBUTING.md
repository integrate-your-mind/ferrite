# Contributing

Ferrite is under a correctness and distribution feature freeze. Changes should
close a documented defect, release gate, or design-partner requirement rather
than add broad React or Next.js parity.

## Before opening a pull request

1. Start from the current delivery branch and keep one owner per mutable PR.
2. Add a minimal reproduction for each defect.
3. Cover normal, failure, odd, retry/timeout, and cleanup behavior where relevant.
4. Run formatting, lint, type checks, builds, tests, browser proof, package
   verification, and deployment proof that apply to the change.
5. State exact commit and test evidence. Do not treat a local run as hosted CI,
   registry publication, staging, or production proof.

## Pull requests

Keep compiler, runtime, routing, packaging, and deployment changes focused and
stack dependent work explicitly. Do not merge, publish, deploy, or change
repository settings without direct maintainer approval.
