---
---

Auto-sync the per-run container image pins during the changesets `version` step so the
"Release Packages" PR is born tag-consistent. A harness bump ships a changeset, so the
release PR bumps the harness `version` a second time and used to leave the hand-maintained
`deploy/backend/{package.json,wrangler.toml}` + `RECOMMENDED_HARNESS_IMAGE` pins behind —
red CI on the image-tag consistency guard. `scripts/sync-runner-image-tags.mjs` (wired into
the root `version` script, also exposed as `pnpm sync:image-tags`) re-derives every pin from
the freshly-bumped harness version. CI/infra only; no package behaviour change.
