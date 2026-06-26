---
---

CI: add a change-gated production deployment pipeline (deploy.yml) that, on merge
to main, deploys only the surfaces that actually changed — D1 migrations, the
Cloudflare runner image, the backend Worker, and the frontend Pages SPA. Deploy
jobs run under a protected `environment: production` (so the Cloudflare credentials
are scoped to those jobs and subject to its branch policy / required reviewers), the
workflow refuses to run from any ref other than main (a `workflow_dispatch` against
an unreviewed branch can't ship to production), and every job carries a
`timeout-minutes` so a hung deploy can't hold the deploy concurrency lock.

Change detection diffs against a moving `prod-deployed` marker tag (the last
successfully-deployed commit), not the single pushed commit, so a surface changed by
an intermediate merge whose run was superseded while the deploy was serialized is
still picked up rather than silently skipped; a failed deploy leaves the marker
unmoved so the next push retries it. The image job hard-fails if the runner sources
changed but the pinned image tag wasn't bumped (which would otherwise publish over
the live tag without rolling out new code), and the Worker deploy uses `!cancelled()`
so a cancelled run can't still ship.
