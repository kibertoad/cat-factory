// The briefs the suite hands the platform: two scaffold prompts, a feature, and a bug report.
//
// These are the suite's INPUT, and they carry its single most important design decision, so they
// live in one file with the reasoning attached rather than being scattered inline.
//
// ## Where the defect comes from, and why it is planted in the SPECIFICATION
//
// Spec 03 can only investigate a bug that spec 02 actually shipped, so something has to put one
// there. The obvious approach (telling the coder to write a bug) does not survive the pipeline:
// `pl_build` runs a `reviewer` step against the implementation, and a deliberate defect inside one
// service is exactly what a reviewer is for. It would be caught, the run would bounce, and spec 03
// would arrive to find nothing wrong. An acceptance suite whose premise the product correctly
// destroys is not a test of anything.
//
// So the defect is a CONTRACT MISMATCH planted in the requirements themselves: the backend's brief
// says `offset` counts from 1, the frontend's says it counts from 0. Each service is then
// implemented faithfully, reviewed against its own brief, and found correct, because it IS
// correct. The defect exists only in the space BETWEEN them, which no single-repository review can
// see, and it manifests only when both run together, which is what the ephemeral environment is
// for. It is also the most ordinary integration bug there is, which is the point: the suite is
// worth more demonstrating the product against a realistic defect than against a contrived one.
//
// The consequence for the assertions, stated here because it is easy to misread as a weakness:
// **spec 02 asserts that the DELIVERY MACHINERY worked, never that the product is defect-free.**
// By construction it is not. See `acceptance/02-feature-with-defect.acceptance.ts`.

import { MANIFEST_DIR } from './k3s.ts'

/**
 * What each adopted service IS, in one sentence, for the frame's `description`.
 *
 * Part of this file rather than of the spec because it is a brief like the others: a service frame's
 * description is what kernel's `describeOwnService` lifts into `AgentRunContext.ownService`, so this
 * text reaches EVERY agent the suite runs (CLAUDE.md: "a step's prompt names the service the work
 * belongs to"). A pass marker in this field told each coder, tester and reviewer that the system
 * under work was called `Acceptance pass 20260810203000`, which is the suite degrading the very
 * context it exists to grade the product on.
 *
 * The run id is deliberately NOT here. What identifies a pass is the frame TITLE (prefixed) and the
 * ledger; the description's only reader is a model deciding what it is building.
 */
export const SERVICE_DESCRIPTIONS: Record<'backend' | 'frontend', string> = {
  backend:
    'The catalog API: a small production-shaped HTTP backend in TypeScript on Node 22 (Fastify) ' +
    'serving a paginated product catalog, deployed per pull request to Kubernetes.',
  frontend:
    'The catalog web app: a small single-page frontend in TypeScript (Vite, no UI framework) ' +
    'rendering the catalog served by the companion catalog API, deployed per pull request to ' +
    'Kubernetes.',
}

/**
 * The manifest brief both services share.
 *
 * Also the reason the two scaffold briefs below are written for an ORDINARY pipeline run rather
 * than for the bootstrapper agent: they now arrive as the `description` of a `pl_build` task
 * against an adopted repository, so what they ask for has to be a pull request's worth of work.
 *
 * `{{image}}`, `{{namespace}}` and `{{branch}}` are rendered by the platform at provision time
 * (see `backend/docs/local-k3s-environments.md`); the agent must emit them VERBATIM rather than
 * resolving them, which is the instruction agents most often improve on unprompted.
 *
 * **The Ingress host is the CONFIGURED template**, never a literal. The platform derives an
 * environment's URL from the same `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE` it hands the engine
 * (`k3s.ts`), so a brief naming a different host ships manifests serving one name behind a URL
 * built from another: an environment that never answers, on a deployment whose only fault was
 * overriding a documented variable. Nothing would fail: spec 02 asserts the URL sits under the
 * configured suffix, and it would.
 */
function manifestBrief(servicePort: number, ingressHostTemplate: string): string {
  return `
Ship per-PR Kubernetes manifests in \`${MANIFEST_DIR}/\` as plain YAML documents (a Deployment, a
Service and an Ingress). They are applied directly to the API server without any kustomize or helm
render step, so every file must be valid Kubernetes YAML exactly as committed.

Rules that are NOT negotiable, because the platform renders them:
- Use the literal placeholder \`{{image}}\` as the container image. Do not resolve it to a real
  image reference; the platform substitutes it per environment.
- Use the literal placeholder \`{{namespace}}\` wherever the namespace appears, and do not set a
  hard-coded \`namespace:\` on any resource.
- The Ingress host must be exactly \`${ingressHostTemplate}\`, placeholders included and unresolved.
- The Service must expose port ${servicePort} and the container must listen on ${servicePort}.
- Give the Deployment a readiness probe on \`/health\`, and keep replicas at 1.

Also ship a GitHub Actions workflow that builds the Dockerfile and pushes the image on every push
to any branch, tagged with the commit SHA, so a branch always has an image to pull.`.trim()
}

/** The backend scaffold brief. Note the 1-based \`offset\`: one half of the planted mismatch. */
export function backendScaffoldBrief(ingressHostTemplate: string): string {
  return `
Create a small, production-shaped HTTP backend service in TypeScript on Node 22, using Fastify.

Scope, deliberately tiny:
- \`GET /health\` returns \`{"status":"ok"}\` with HTTP 200.
- An in-memory catalog of exactly 25 items, each \`{ "id": <1..25>, "name": "Item <id>" }\`, seeded
  at startup. There is no database and must not be one.
- \`GET /items\` returns the whole catalog as \`{ "items": [...], "total": 25 }\`.

Engineering expectations:
- A Dockerfile that builds a runnable image; the server listens on port 3000 and binds 0.0.0.0.
- Vitest unit tests covering the routes, and an \`npm test\` script that runs them.
- A README documenting every route with an example request and response.
- Lint and typecheck scripts that pass.

${manifestBrief(3000, ingressHostTemplate)}`.trim()
}

/** The frontend scaffold brief. Deliberately says nothing about pagination yet; the feature adds it. */
export function frontendScaffoldBrief(backendRepo: string, ingressHostTemplate: string): string {
  return `
Create a small single-page web frontend in TypeScript using Vite and plain TypeScript (no UI
framework), which renders the catalog served by the companion backend service (\`${backendRepo}\`).

Scope, deliberately tiny:
- A single page that fetches the catalog and renders each item's name in a list, with a stable
  \`data-testid="item-list"\` on the list and \`data-testid="item-row"\` on each row.
- The backend's base URL comes from the \`API_BASE_URL\` environment variable, read at runtime, and
  must not be hard-coded.
- \`GET /health\` on the frontend's own server returns \`{"status":"ok"}\` with HTTP 200.

Engineering expectations:
- A Dockerfile that builds the app and serves it on port 8080, binding 0.0.0.0.
- Vitest unit tests for the rendering logic, and an \`npm test\` script that runs them.
- A README documenting how to run it and which environment variables it reads.
- Lint and typecheck scripts that pass.

${manifestBrief(8080, ingressHostTemplate)}`.trim()
}

/**
 * The backend half of the feature.
 *
 * The 1-based `offset` is stated as a flat requirement with a worked example, so an agent
 * implementing it faithfully produces exactly the half of the mismatch this side owns. It reads
 * as an ordinary (if slightly unusual) API decision, which is what makes it survive review.
 */
export function backendFeatureBrief(): string {
  return `
Add pagination to \`GET /items\`.

The endpoint accepts two optional query parameters:
- \`offset\`: the position of the first item to return. **Positions are 1-based: the first item in
  the catalog is at offset 1.** Defaults to 1. Be defensive about the lower bound: an offset below
  1 is clamped to 1 rather than rejected, so a caller can never be handed a 400 for asking for the
  start of the list.
- \`limit\`: how many items to return, 1..50. Defaults to 10. Out of range is a 400.

The response stays \`{ "items": [...], "total": 25 }\`, where \`total\` is the size of the whole
catalog rather than of the page.

Worked example, which the tests must cover: \`GET /items?offset=1&limit=3\` returns items 1, 2 and 3;
\`GET /items?offset=4&limit=3\` returns items 4, 5 and 6.

Document the 1-based offset prominently in the README, including the worked example.`.trim()
}

/**
 * The frontend half.
 *
 * Says `offset = (page - 1) * limit`, which is internally consistent and 0-based. Neither brief
 * mentions the other's convention, and neither repository's tests can see the disagreement: that
 * is the whole mechanism.
 *
 * The trace it produces against the 1-based backend, which is what the bug report describes and
 * what makes the defect subtle enough to survive spec 02's testers: page 1 asks for offset 0,
 * which the backend CLAMPS to 1 and answers items 1-10, so the first page is accidentally right.
 * Page 2 asks for offset 10 and gets items 10-19, repeating item 10. Nothing is ever missing,
 * which is why a smoke check of the first page passes.
 */
export function frontendFeatureBrief(): string {
  return `
Add paging to the catalog page.

- Show 10 items at a time, with "Previous" and "Next" buttons carrying \`data-testid="page-prev"\`
  and \`data-testid="page-next"\`, and a page indicator with \`data-testid="page-indicator"\` reading
  \`Page <n>\`, where the first page is page 1.
- Fetch a page from the backend's \`GET /items\` endpoint using its \`offset\` and \`limit\` query
  parameters. **Compute the offset as \`offset = (page - 1) * limit\`, so page 1 requests offset 0**,
  and pass \`limit=10\`.
- Disable "Previous" on the first page, and "Next" once the last page is shown, using the \`total\`
  the backend reports.

Cover the offset arithmetic and the button states with unit tests.`.trim()
}

/**
 * The bug report spec 03 files.
 *
 * Written as a REPORTER would write it: the observed symptom, how to see it, and nothing else. No
 * root cause, no file names, no mention of pagination arithmetic or of two conventions: supplying
 * those would hand the `bug-investigator` its own conclusion and reduce the step to a formality.
 * What makes this a fair test is that everything needed to diagnose it is discoverable in the two
 * repositories, and none of it is in this text.
 *
 * `liveEnvironmentUrl` is a URL the caller has established is still STANDING
 * (`retainedEnvironmentUrl` in `evidence.ts`), never merely one a settled report recorded. Absent
 * is stated as "reproduce locally" rather than omitted: a report that silently drops its "where"
 * reads to an investigator like one whose reporter never had an environment at all.
 */
export function bugReportBrief(liveEnvironmentUrl: string | null): string {
  const where = liveEnvironmentUrl
    ? `The environment the feature shipped to is at ${liveEnvironmentUrl}.`
    : 'Reproduce it against a locally running pair of the two services.'
  return `
Paging through the catalog shows me the same item twice.

What I did:
1. Opened the catalog page. It says "Page 1" and lists "Item 1" through "Item 10". That looks right.
2. Clicked "Next". It says "Page 2", but the list starts at "Item 10" again (the same item that
   ended page 1) and runs to "Item 19".
3. Clicked "Next" again. "Page 3" says "Item 20" through "Item 25", which follows on correctly from
   page 2, but it is only 6 rows where the earlier pages had 10.

So page 1 looks right, page 2 begins by repeating the last row of page 1, and the last page is
short. Going back and forward again gives the same thing, and reloading does not help. The list was
correct before paging was added.

${where}`.trim()
}
