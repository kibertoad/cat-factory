# cat-factory

Software development agent management platform

## Documentation

High-level docs (most live under [`backend/docs/`](./backend/docs)):

- **[Backend overview](./backend/README.md)** — the Cloudflare Workers + D1
  monorepo, its hexagonal layering, and how the pieces fit together.
- **[Authentication](./backend/docs/auth.md)** — "Login with GitHub"; GitHub
  accounts are the identity provider, so there's no separate user store.
- **GitHub integration** — connect each workspace to GitHub via a **GitHub App**
  (works with a personal account or an org) for repo/PR/issue read & write plus
  webhooks. [Design](./backend/docs/github-integration.md) ·
  [Setup runbook](./backend/docs/github-operations.md) ·
  [App Manifest](./backend/docs/github-app-manifest.html). Self-hosted, so each
  deployment registers its own App.
- **[Document sources](./backend/docs/document-sources.md)** — link requirements,
  RFCs and PRDs from external sources to a board and expand them into structure.
- **[Ephemeral environments](./backend/docs/environments-integration.md)** — plug
  in your own preview-environment tooling via a declarative HTTP manifest so
  `deployer`/`tester` agents can provision and run against it.
- **[Storage & retention](./backend/docs/storage-and-retention.md)** — the D1 data
  model's retention sweeps and follow-ups.
- **[Implementer harness](./backend/packages/implementer-harness/README.md)** — the
  payload that runs inside a per-run Cloudflare Container to do real code changes.

### Architecture decisions

- [ADR 0001 — GitHub integration via a GitHub App](./backend/docs/adr/0001-github-app-integration.md)
- [ADR 0002 — Cloudflare as the runtime platform](./backend/docs/adr/0002-cloudflare-platform.md)
- [ADR 0003 — Pluggable ephemeral-environment providers](./backend/docs/adr/0003-ephemeral-environment-provider.md)
