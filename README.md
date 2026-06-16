# cat-factory

Software development agent management platform

## GitHub integration

cat-factory connects each workspace to GitHub via a **GitHub App** (works with a
personal account or an org) for repo, pull request, and issue read/write plus
webhooks. It's self-hosted, so each deployment registers its own App. See
[`backend/docs/github-operations.md`](./backend/docs/github-operations.md) for
setup — including an [App Manifest](./backend/docs/github-app-manifest.html) that
pre-fills the App-creation flow — and
[`backend/docs/github-integration.md`](./backend/docs/github-integration.md) for
the design.
