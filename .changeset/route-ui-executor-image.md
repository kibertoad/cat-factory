---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/integrations': minor
---

Route a job to the UI-tester executor image, on every backend, and publish that image.

The `image: 'ui'` dispatch variant has existed since the visual-confirmation gate landed: the
`tester-ui` kind declares it, the executor sets it, the job body carries the screenshot-upload
seam and the reference-design manifest that go with it. Nothing mapped it to an image. On
Cloudflare and local Docker a browser-driven tester therefore ran on the plain executor image,
which has no browser, and the repo published no UI image for anything to point at even if it had.

The variant now travels on the job REF rather than only on the dispatch options, because a
per-run container backend has to address the same container again on every poll and release, and
those get no options. `containerKeyForRef` derives the container's identity from it (the run id,
qualified by the variant), and the executor re-derives the variant from the step's agent kind at
each site, so a poll from a fresh process after a durable replay lands on the right container with
nothing remembered in between. Cloudflare gains a `UiTesterContainer` class bound as
`UI_CONTAINER`; local Docker gains `LOCAL_HARNESS_IMAGE_UI` and a second per-run container.

**An unwired variant is refused, not downgraded.** Every backend fails the dispatch, naming the
binding or variable to set, where the Kubernetes pool previously fell back to its default image.
Falling back is what the variant existed to prevent: the tester runs happily until it needs a
browser, which is after the checkout, the install and the model's first turns, and reports an
`abort` no reader can distinguish from an app that would not start. A deployment that has not
wired the image loses the step, not the diagnosis, and the visual-confirmation gate still runs on
screenshots a person uploads.

Two things to watch. The live-container inventory carries the variant (D1 migration 0094) because
the cron reaper kills through a Durable Object namespace and `idFromName` returns a usable stub in
any of them: reaping a browser container through the executor class killed nothing and reported
success. And the local orphan sweep now maps a container key back to its run before asking whether
that run is live, or every UI container reads as belonging to no run and is swept out from under a
run mid-step.

The UI image is published by CI alongside the executor image it layers on, pinned to the same
version, and is BOOTED before it is pushed: the smoketest starts a container, waits for the
harness, then drives a real Chromium against a `serve`d page inside it. A build-only gate was not
enough, which the corepack line this branch already fixed demonstrates: it had been unrunnable
since the base moved to `node:26` and no build ever failed for it.
