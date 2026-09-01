---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Import an organisation's Backstage catalog, so triage agents know which services exist and who owns them

The platform knew a great deal about the service being built and, since ADR 0031, about the shared
capabilities a deployment registered by hand. It knew nothing about the rest of the estate. That
cost most on the triage path: a bug investigator looking at a cross-service report had the
repositories it was handed and no record of what else the organisation runs, who owns it, or what
it exposes, so "which service is this?" was answered from repository names.

Most organisations already record exactly that, in a developer portal. A workspace can now point
the platform at its Backstage instance and have its components arrive as `workspace`-tier
foundational services: identity, owner, system, domain and lifecycle composed into the
description, tags as capabilities, and each API entity's definition stored as one of the service's
contracts.

**It feeds the EXISTING catalog rather than standing beside it**, which is the decision the rest
follows from. A parallel mechanism would have meant a second `.cat-context/` directory, a second
set of trait guidance, a second tiered merge and a second suppression surface, all describing the
same organisation to the same agents. So an imported service is an ordinary catalog row carrying
`sourceId: 'service-catalog'`, and the tier merge, the suppression sub-resource, the lazily-read
contract documents and the SPA's catalog list are untouched.

**Triage agents read it under a new `service-estate` trait, deliberately not the design one.**
`foundational-catalog` asks its kind to prefer consuming a shared service and to end its reply
with a machine-read declaration block; both are wrong for an agent whose job is to locate a fault,
and the second is worse than wrong, because `bug-investigator` and its peers are structured-output
kinds whose reply IS a JSON object. The estate file states ownership and interface surface and
asks for nothing back. `bug-investigator` and `on-call` carry it; a deployment's own kind opts in
through `registerAgentKind({ traits })`. It carries no contract DOCUMENTS: an orientation read
happens on every triage dispatch, and folding every service's OpenAPI document into one would make
the prompt scale with the size of the organisation's specs, which is what the catalog/contracts
split exists to prevent.

**The auth modes are a closed vocabulary of the shapes a self-hosted portal actually runs
behind**: a static service token, the legacy shared secret (a short-lived HS256 token the platform
mints per pass), OAuth2 client credentials for an instance behind an IdP or an identity-aware
proxy, HTTP Basic for a reverse proxy, an explicit header list for a gateway that authenticates on
its own names, and none at all for an instance reachable only inside a VPN. Free-form headers
alone would have covered the mechanics and lost every remedy an operator needs when one fails. Two
details are load-bearing: the legacy secret is base64-DECODED into an HMAC key rather than used as
UTF-8 (which is what decides whether the token verifies at all, so a secret that is not base64 is
refused rather than signed with the wrong key), and the header mode takes a LIST because the
common case needs two: a Cloudflare Access service token is an id plus a secret, and a
single-pair shape would have sent half a credential.

Reviewers may want to look hardest at three things.

**Widening the URL guard is the ordinary case here, not an exception.** A self-hosted portal
usually lives on an internal host, so `SERVICE_CATALOG_ALLOW_URL_HOSTS` /
`SERVICE_CATALOG_ALLOW_HTTP_URLS` exist and are scoped to this integration alone. Redirects are
followed by hand and re-checked per hop, with the body and `Authorization` dropped on a
cross-origin one, because the base URL is operator-supplied.

**A partial import must never read as the estate.** An import reports `complete` / `truncated` /
`empty` coverage plus two skip counts, and stamps `ok` / `partial` / `failed` with a sentence on
the connection. `empty` is `partial` rather than a healthy import of zero services, because a
filter that matched nothing is a configuration problem with a remedy. A failure is stamped BEFORE
it propagates and tombstones nothing: an unreachable portal and an empty one are opposite facts.

**Two size ratchets moved DOWN, both by splitting.** The Worker's `container.ts` lost its three
content-library selectors to a new `container-content-library-deps.ts`, the twin of the file the
Node facade already had, so both facades now hold the same selectors in the same place (874 → 800).
`orchestration`'s `dependencies.ts` lost the same three libraries' declarations to
`content-library-dependencies.ts`, which `CoreDependencies` extends (1514 → 1301, under the
default).

Also in here, because the import needs them: `asyncapi`, `graphql` and `grpc` join the
contract-format vocabulary, with AsyncAPI indexed (its channels are a parse, not a guess) and the
other two answering through `operationsAreIndexable` as formats nobody reads. `ApiContractManifestEntry`
gains `sourceSha`, so a sync can decide whether a document changed without reading a body.
