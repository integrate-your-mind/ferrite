# Security Policy

Ferrite is an experimental developer preview. It does not yet provide a stable, production-supported release line.

## Supported versions

Only the latest commit on `main` receives security fixes. Older commits, tags, local builds, unpublished package candidates, and downstream forks are not supported.

| Version | Supported |
| --- | --- |
| Latest `main` | Best effort |
| Earlier commits or tags | No |
| Unpublished package candidates | No |

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Use GitHub's **Security → Report a vulnerability** flow when it is available for this repository. If private vulnerability reporting is not yet enabled, contact the repository owner privately through GitHub and share only enough information to establish a secure reporting channel.

Include:

- the affected commit or tag;
- the affected component and entry point;
- clear reproduction steps or a minimal proof;
- the expected and observed security boundary;
- known prerequisites and impact;
- any suggested fix or mitigation;
- whether the issue has been disclosed elsewhere.

Remove credentials, personal data, production data, and unrelated secrets from all reports.

## Response process

The maintainer will try to:

1. acknowledge a complete private report;
2. reproduce and assess the issue;
3. agree on disclosure timing where practical;
4. prepare a fix and regression test;
5. publish an advisory when the repository and affected surface support one.

Response times are best effort because Ferrite is not yet a supported production product.

## Current security boundaries

Ferrite's direct server is designed as a narrow private upstream behind a mature edge proxy. Do not expose it as a general public HTTP edge. The current server-action, replay, authentication, deployment, and multi-process limits are documented in the README and deployment docs.

A public repository, passing local tests, or a merged pull request does not by itself establish production security.
