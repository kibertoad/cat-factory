# ADR 0019: Frontend board blocks, self-contained UI testing, and browsable dev previews

- **Status:** Accepted (implemented)
- **Date:** 2026-07-10
- **Context layer:** backend + frontend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/orchestration`, `@cat-factory/server`, `backend/internal/executor-harness`, `backend/runtimes/*`, `@cat-factory/app`)

## Context

cat-factory could already spin up an ephemeral backend environment for a service under test
(the `deployer` step) and run agent-driven UI tests (`tester-ui`) against it, but had no
notion of a **frontend**: nothing declared that a backend had a frontend counterpart, built
and served that frontend pointed at the ephemeral backend, mocked its other upstream
dependencies, or ran the UI tests against the two running together. Repo onboarding also had
no way to distinguish a frontend/library/document repo from a backend service.

## Decision

- Add a first-class **`frontend` board block type**, one of four onboardable frame repo roles
  (`service` / `frontend` / `library` / `document`); `block.type` becomes **behavioural**
  (previously cosmetic) for these four roles.
- A frontend frame carries a `frontendConfig` (stored like `provisioning`, one JSON column) with
  per-env-var **backend bindings** to service frames, each resolving to a live ephemeral URL or
  falling back to a WireMock stub.
- A **self-contained UI-test flow**: one `ui`-variant harness container builds the frontend from
  its branch, injects the bound ephemeral backend URL(s), stands up WireMock (seeded from a
  `mocks/` directory in the repo) for every other upstream, serves the built app, and runs the
  existing `tester-ui` agent kind against it — reusing the kind, image, and result view rather
  than inventing a parallel test surface.
- A **browsable dev preview** as a second, local/node-only serve topology: a long-lived
  build+serve+WireMock process that stays alive after the job completes, exposed via a new
  `PreviewTransport` port, `PreviewService`, and inspector controls. Gated by a
  `frontendPreview.supported` infrastructure-capability descriptor (Cloudflare `false`; Node/local
  `true`) read by the SPA to disable-with-hint rather than hard-remove the toggle.
- **Reverse CORS injection**: a frontend's bound-service origins (`http://localhost:<servePort>`)
  are computed (`frontendOriginsForService`) and passed to the deployer's provisioning template as
  `{{input.frontendOrigins}}` (manifest provider) / `{{frontendOrigins}}` (Kubernetes adapter), so
  an operator can fold them into the backend's CORS allow-list.
- The local preview's host port is **pinned to the serve port** (not left ephemeral) so the
  browsable preview origin and the injected CORS origin are the identical string — Docker-family
  runtimes only; Apple `container` (no pinnable localhost) is excluded from the injection.

## Rationale

- Reusing `tester-ui`'s existing kind/image/result-view kept the whole flow a step ordering
  change (`pl_frontend`), not new engine machinery.
- Modelling the frame-type-behavioural distinction generically (not `frontend`-specific) let
  `library`/`document` repo types ride the same seam.
- WireMock gives a single, consistent mocking mechanism for every non-bound upstream instead of a
  bespoke stub server per case.
- Treating the browsable preview as a **topology capability** (not a per-run engine gate) matches
  how the SPA actually consumes it — a static "can this runtime serve a preview" fact, not a
  per-run precondition.
- Pinning the preview's host port to the serve port was chosen over a distinct "preview port"
  config field or an ephemeral-port fallback specifically because browsers treat `localhost` and
  `127.0.0.1` as different CORS origins — a mismatch would silently break the exact scenario the
  preview exists to support.

## Consequences

- Cloudflare never gets a browsable preview (`frontendPreview.supported: false`); only the
  self-contained, torn-down-with-the-run container path is universal.
- A bare Node-with-runner-pool deployment advertises `frontendPreview.supported: true` but has no
  host-port-publish primitive wired yet, so its preview controller 503s until a Kubernetes-ingress-
  backed preview transport is built (tracked as a Node follow-up, not blocking).
- Apple `container` (VM-per-container, no host loopback) cannot produce a pinnable preview origin
  and is excluded from the CORS-origin injection.
- Routing `tester-ui` to the `ui`-tagged image on a per-step basis (rather than the run's first
  step fixing the container image) remains an open, separately-tracked deploy-time change.
- CORS injection is deployer-path only; an operator must still author the manifest mapping and
  re-provision the backend when a frontend link or serve port changes.
