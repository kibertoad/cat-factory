# ADR 0045: A deployment owns document credentials, so a code-registered fragment can name a living document

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/integrations`, `@cat-factory/agents`, `@cat-factory/orchestration`,
  `@cat-factory/server`, all three runtime facades) + docs

Closes the one substantive gap [ADR 0040](./0040-deployment-extension-seam-reachability.md) left
open and [ADR 0044](./0044-facade-extension-surface.md) restated: a `documentRef` on a
code-registered prompt fragment was refused. Feature context:
[reusable operations](../reusable-operations.md).

## Context

A deployment registers its best-practice standards in code, on the `PromptFragmentRegistry`. Those
land on the `builtin` tier. A `documentRef` on one was carried through the catalog merge, put on the
wire and badged "live from `<source>`" by the library UI, while `resolveDocumentBody` short-circuited
on the tier and served the registered body. ADR 0040 turned that into a boot error, which was right:
the reference genuinely did nothing.

The justification given for the refusal, though, conflated two things. It said a deployment-wide
registration "names no connection workspace", which reads as a claim about the SCOPE of the
registration. That scope is correct and was never the problem. The real constraint was the
CREDENTIAL HOME: every document source authenticates per workspace.
`DocumentContentResolverService` reads `requireConnection(workspaceId, source)`; the one provider
that stores no credentials (`github-docs`) rides `resolveImplicitConnection(workspaceId)`, the
WORKSPACE's App installation; and `fetchDocument(credentials, externalId, workspaceId)` is
workspace-parameterised besides. With nothing else available, honouring the field would have meant
the engine picking a tenant to fetch through on behalf of a fragment every tenant folds.

So the capability was missing, not incoherent. A deployment already configures credentials in its
own environment, and its fragments are already deployment-wide.

## Decision

**Document credentials get a DEPLOYMENT-scoped home**, read from `DOC_SOURCE_<SOURCE>_<FIELD>` and
served by a new kernel port, `DeploymentDocumentResolver` (`configured` / `fetch` / `probeVersion`,
with no workspace argument). A `builtin`-tier `documentRef` resolves through it, cached under one
`DEPLOYMENT_DOCUMENT_CACHE_GROUP`.

**Which sources can do this is a declared TRAIT, not an inference.** `DocumentSourceTraits` gains
`deploymentScoped`, exhaustive over the source picklist beside `design` and `hostPinned`. It is
false for `github` alone, because its credential is a workspace's App installation. Boot refuses a
registration naming it with a message about the credential rather than a variable that cannot exist,
and the provider refuses the scope again at the second door.

**The provider port spells the deployment scope `null`, never a sentinel workspace id.** That is
what makes the second refusal possible: a fake id would look exactly like a real one to the provider
that has to reject it.

**Boot validation now asks whether THIS deployment can serve the ref**, not whether a builtin ref is
allowed. It checks the trait FIRST and the resolver second, because the two answer different
questions (what the source can do, versus what this process configured) and asking the resolver
first would let a too-generous implementation admit a registration no configuration can make work.

**The variables are derived from each provider's own `credentialFields`**, the list that already
renders its connect form, so a new source adds no configuration code. A source with SOME of its
variables set is reported as a problem and left unconfigured, never silently skipped.

**In mothership mode the credential stays put and the BODY crosses**, over
`POST /internal/prompt-fragments/document-bodies`, mirroring `/internal/foundational-services/contracts`.

## Rationale

- **One cache group is the point, not an optimisation.** A deployment-wide document keyed per
  workspace would be fetched N times and could never be invalidated in fewer than N calls, with
  nothing knowing what N is. That is precisely the fan-out the account tier's `docViaWorkspaceId`
  rule already refuses, one tier up.
- **A trait, because the alternative is inferring capability from an implementation detail.** Five
  of six providers ignore their `workspaceId` argument today. Reading that as "deployment-scopable"
  would be one refactor away from changing silently, and the consequence of getting it wrong is one
  tenant's credential fetching text into another tenant's prompts.
- **The body crosses the machine API, not the credential.** `ENCRYPTION_KEY`-class configuration
  does not reach a laptop, which is the same rule that keeps a decrypting repository off the remote
  route. Applied to a resolver rather than a repository, it says the mothership must do the fetch.
- **A separate route rather than a field on the pool read.** The pool is read on every catalog miss;
  a document fetch is a call to an external vendor. Folding bodies into it would let one unreachable
  page fail the read of every standard, most of which no run names. Same split, same reason, as the
  foundational-services catalog and its contracts.
- **Degrading to the registered body is right; degrading silently is not.** The prompt is
  byte-identical either way, so nothing downstream can tell a stale standard from a current one. The
  fallback now emits one warning naming the fragment, tier and source. Sites: the resolver on the
  node, and the mothership's route, which is the only process that can see WHY.

## Consequences

- A deployment can point its standards at the documents its people already edit, and an edit reaches
  every future run without a redeploy. That was the consumer request behind ADR 0040, and the
  pointer-fragment workaround (a canonical URL plus enough inline text to stay safe) can go.
- `github` remains the one source this cannot serve. A deployment that wants a living GitHub-hosted
  standard uses the ACCOUNT tier with a fetch-via workspace, which is unchanged and correct.
- `DocumentSourceProvider.fetchDocument` / `probeVersion` now take `string | null`. An internal
  interface, so no migration; every in-tree provider and the Worker's fake were updated with it.
- The env-var guard's own extractor was reading its arrays with a single-quote scan, so one
  apostrophe in an in-array comment silently un-reserved every prefix after it. Found by writing an
  ordinary English comment beside the new `DOC_SOURCE_` family. Fixed to strip comments first, with
  a fixture.
- The `deploymentDocumentResolver` seam is NOT on the entry-point registry classification: it is
  built by each facade from its own configuration (like `providerRegistry`), so there is nothing for
  a deployment to inject and an option would be a second, drifting source of truth.
