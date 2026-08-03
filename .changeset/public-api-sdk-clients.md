---
'@cat-factory/sdk': minor
---

Add official public-API SDK clients for TypeScript, Python, Go and Java (the Java artifact also
serving Kotlin), plus a cross-SDK smoketest and release gating.

Models and operation methods are **generated** from `docs/openapi.json` — itself generated from
the Valibot route contracts — so a client cannot drift from the deployment it talks to. Each SDK's
transport, error hierarchy, retry policy, pagination helper and SSE reader are hand-written, so a
contract change never rewrites behaviour and a behaviour fix is never re-applied 38 times in four
languages. `pnpm gen:sdk` regenerates; `pnpm check:sdk` guards drift and version skew in CI.

`backend/internal/sdk-smoketest` boots a real Node backend and drives the same scenario through
all four clients, comparing their observation reports — the only check that can see the four
disagree.

**No separate Kotlin SDK, deliberately.** Kotlin's own `@Metadata` cannot be synthesised onto a
Java jar, but the metadata Kotlin _reads_ can be: the model and resource packages are JSpecify
`@NullMarked`, Kotlin hard keywords are escaped (`PublicPipeline.public` → `isPublic()`, wire name
preserved), the error hierarchy is sealed, builders replace absent default arguments, and enums
tolerate unknown values. A Kotlin caller gets real nullability instead of platform types; what it
does not get is `copy()`/destructuring on the records.

Also fills a documentation gap in the published OpenAPI spec: 11 operations (the whole
`/api/v1/debug/*` surface plus `deletePublicTask`, `listPublicJobs` and `resolvePublicRunJudge`)
carried no summary or description and were tagged with a catch-all `Public API` tag. They are now
documented and tagged `Debug` / `Tasks` / `Initiatives` / `Decisions`, so the four generated
clients inherit real docs.
