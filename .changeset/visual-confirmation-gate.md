---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add the Visual Confirmation gate and split the tester into an API + UI tester.

- **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
  testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
  non-redundant screenshot of each distinct view, uploads them to the binary-artifact
  store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
  loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
  with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
- **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
  (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
  reference design images (paired by view) and parks for a person to review actual-vs-reference.
  The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
  or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
  binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
- Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
  `listByBlock`.

BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
(no backwards-compatibility shims), any persisted state that still names `tester` simply stops
matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
all use `tester-api`.

NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
routing into it (a second Cloudflare container class; image-per-step on the local/pool
transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
(a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
`experimental`.
