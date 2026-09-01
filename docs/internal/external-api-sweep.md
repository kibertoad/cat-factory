# External API sweep

- **Swept**: 2026-08-18 11:20 UTC
- **Commit**: `97da5e99d`
- **Previous sweep**: none (first sweep)
- **Run by**: the `external-api-sweep` skill
- **Follow-ups**: all fourteen are addressed. What each turned into, including the three that
  resolved to a deliberate decision NOT to change anything, is in [Follow-ups](#follow-ups). The
  findings below are left as the sweep recorded them on the date above: a record edited to match
  what was later done stops being evidence of what was found.

Every hand-written call this repo makes against a service we do not run, checked against the
vendor's live documentation. Nothing in CI can see a vendor move a path, retire a version or
rename a field: typecheck passes, the unit tests pass against our own fakes, and the failure
arrives in production as a 404 on somebody's run. `JiraProvider.ts` already carries that scar in
a comment (Atlassian removed `GET /rest/api/3/search` in May 2025). This sweep found the next
three.

**Act on these first.** Three surfaces have already moved:

1. **Confluence document sources are dead.** `GET /wiki/rest/api/content/{id}` was retired on
   2025-04-30 and is gone from Atlassian's own v1 reference. Two of our three Confluence calls
   target it. Same failure class as the Jira scar.
2. **incident.io enrichment has never worked.** `POST /v2/incident_updates` does not exist at any
   version; incident.io publishes only a `GET`. A bare `catch {}` at the call site has been
   hiding it.
3. **The MCP tool-server probe cannot talk to a current server.** Revision `2026-07-28` removed
   the `initialize` handshake we pin, and the spec's own matrix rates our era-combination
   "Fails" with no fall-forward for legacy clients.

Two more carry announced dates: Langfuse's ingestion API sunsets on Cloud **2026-11-16** (about
three months out), and GitHub's `2022-11-28` pin ends support **2028-03-10**.

## Scope

The inventory is derived, not inherited: `node scripts/check-external-api-inventory.mjs --list`
walks every non-test source file under `backend/`, `deploy/`, `frontend/`, `scripts/` and `sdk/`
and finds a surface two ways, because each is blind to what the other sees. A **call site** is one
we send (the global `fetch`, our `safeFetch` and host-pinned wrappers, and any file that resolves
or types an injected transport, which is the only thing that catches a call through a locally bound
alias). An **endpoint declaration** is one something else sends to: a binary generator's descriptor
an agent calls with its own credential, a provider base URL an SDK appends a path to. This pass
covered **117 surfaces across 34 vendors**, all classified.

Three gaps neither direction reaches were closed by hand:

- **Version pins**, four schemes rather than one: a header (`x-github-api-version`,
  `notion-version`), a path segment (`/rest/api/3`, `/v1beta/`, `/api/v4`), a **media type**
  (`application/vnd.pagerduty+json;version=2`), and a versionless path a vendor still relocates
  (Langfuse's `/api/public/ingestion`, which is exactly the one that turned out to have a sunset).
- **Base URLs that only ever arrive from config**: Confluence composes
  `${credentials.baseUrl}/wiki/rest/api/content/...`, and a self-hosted GitLab, a Jira site and a
  Datadog EU site all move the host while the path stays ours to get wrong.
- **The configurable-but-unswept vendor**: cross-checked the derived list against
  [`environment-variables.md`](../environment-variables.md), the capability-credential kinds and all
  37 directories under `backend/packages/integrations/src/modules/`. Every vendor a deployment can
  configure is either swept below or excluded here. `BIFROST_BASE_URL` and `LITELLM_BASE_URL` are
  operator-hosted gateways with no public endpoint to verify, covered under `openai-compatible`.

Excluded deliberately, so "excluded" and "overlooked" cannot read the same:

- **SDK-mediated calls**: `@ai-sdk/*`, `ai`, `workers-ai-provider`, `@aws-sdk/*`, the database
  drivers. The SDK owns the wire shape, so currency there is a dependency bump under the
  `minimumReleaseAge` rules. The **hosts** those SDKs are pointed at are ours and are swept. One
  boundary worth naming for the dependency sweep rather than this one: the Vercel AI SDK family is
  held to the major that pairs with `workers-ai-provider` (`ai@^7` + `@ai-sdk/*@^4`).
- **Our own surfaces**: `/api/v1`, `/internal/*`, the runner and container HTTP, the persistence
  RPC. Governed by the public-API stability rules in CLAUDE.md.
- **Build-time supply chain**: the `download.docker.com` apt repo, `repo1.maven.org`,
  `https://get.k3s.io`, and the registries a job's own `npm install` hits (the harness only writes
  the npmrc that routes them). They break a build rather than a run and move on the image's
  schedule.
- **A web URL handed to a human** is neither a call site nor an endpoint declaration. The GitLab
  PAT-creation deep link (`backend/packages/cli/src/vcs.ts:45`,
  `backend/runtimes/local/src/github.ts:360`) is a browser destination, not an API we call.

## Summary

Worst verdict first, then by severity, then by vendor. Unverifiable outranks Drifting on purpose:
an unchecked call may be either of the two above it, and filing it below a known-and-benign one is
the same collapse the verdict exists to refuse.

| Vendor                    | API + version                                       | Call sites                                                                | Verdict                   | Severity |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------- | -------- |
| Confluence                | Cloud REST **v1** (`/wiki/rest/api/content`)        | `ConfluenceProvider.ts:117,164`                                           | **Broken**                | High     |
| MCP (protocol)            | revision pin `2025-11-25`                           | `mcpProbe.ts:52`                                                          | **Broken**                | High     |
| incident.io               | `/v2` (`POST /v2/incident_updates`)                 | `IncidentIoEnrichmentProvider.ts:52`                                      | **Broken**                | Medium   |
| Langfuse                  | `/api/public/ingestion` (unversioned)               | `observability-langfuse/src/index.ts:95`                                  | **Deprecated 2026-11-16** | Medium   |
| GitHub                    | REST `x-github-api-version: 2022-11-28`             | 14 non-test files (see below)                                             | **Deprecated 2028-03-10** | Low      |
| npm registry              | `GET /{package}`                                    | `check-release-versions.mjs:88`                                           | **Unverifiable**          | Low      |
| Google (OAuth/OIDC)       | `/o/oauth2/v2/auth`, `/token`, `oauth2/v3/userinfo` | `GoogleOAuth.ts:56,75,88`                                                 | Drifting                  | High     |
| Cloudflare                | AI Gateway `workers-ai/v1` segment                  | `endpoints.ts:168`                                                        | Drifting                  | Medium   |
| Datadog                   | `/api/v1` monitors + SLO, `/api/v2` logs            | `DatadogClient.ts:101,122,153`                                            | Drifting                  | Medium   |
| Figma                     | REST `/v1` + OAuth                                  | `FigmaProvider.ts:612,635`, `figma.logic.ts:63-65`                        | Drifting                  | Medium   |
| Google Gemini             | Interactions API `/v1beta`                          | `nano-banana.openapi.ts:69`, `nano-banana.ts`                             | Drifting                  | Medium   |
| Linear                    | GraphQL (unversioned)                               | `linear.client.ts:16`, `linear.logic.ts:113,187,190,423`                  | Drifting                  | Medium   |
| MCP authorization         | RFC 8414 / 9728 well-known walk                     | `mcpOAuthClient.ts:212,241-243`                                           | Drifting                  | Medium   |
| Alibaba DashScope         | `compatible-mode/v1` on the `-intl` host            | `endpoints.ts:9`                                                          | Drifting                  | Low      |
| DeepSeek                  | `/v1` (plus `/anthropic`)                           | `endpoints.ts:10`, `models.ts:116`                                        | Drifting                  | Low      |
| Notion                    | `notion-version: 2022-06-28`                        | `NotionProvider.ts:20-22,208,261`                                         | Drifting                  | Low      |
| OpenRouter                | `/api/v1/models`                                    | `OpenRouterCatalogService.ts:30`, `openRouterModels.ts`                   | Current                   | Low      |
| Brave Search              | `/res/v1/web/search`                                | `upstreams.ts:57`                                                         | Current                   | Low      |
| GitLab                    | REST **v4**                                         | `FetchGitLabClient.ts` + 4 siblings                                       | Current                   | High     |
| Jira                      | Cloud REST **v3**                                   | `JiraProvider.ts`, `TicketTrackerService.ts:125`, `jira.writeback.ts:88`  | Current                   | High     |
| Kubernetes                | core `/api/v1` + SSA media type                     | `KubernetesApiClient.ts`, `kubernetes.logic.ts:191`                       | Current                   | Medium   |
| Moonshot                  | `/v1` + `/anthropic`                                | `endpoints.ts:11`, `models.ts:111`                                        | Current                   | Low      |
| OIDC (generic SSO)        | Discovery 1.0 + JWKS                                | `auth/oidc/discovery.ts:97`, `OidcClient.ts`                              | Current                   | High     |
| OpenAI                    | `/v1`                                               | `endpoints.ts:12`                                                         | Current                   | Low      |
| OpenAI-compatible (proxy) | `${baseURL}/chat/completions`                       | `LlmProxyController.ts:587`                                               | Current                   | Medium   |
| OTLP                      | `/v1/traces`, `/v1/metrics`, `/v1/logs` (JSON)      | `observability-otel/src/index.ts:97-98`, `logs.ts:120`, `platform.ts:101` | Current                   | Low      |
| PagerDuty                 | `vnd.pagerduty+json;version=2`                      | `PagerDutyEnrichmentProvider.ts:52,70`                                    | Current                   | Medium   |
| Resend                    | `POST /emails`                                      | `email/adapters.ts:52`                                                    | Current                   | Low      |
| SearXNG                   | `/search?format=json`                               | `upstreams.ts` (SearXNG upstream)                                         | Current                   | Low      |
| SendGrid                  | `/v3/mail/send`                                     | `email/adapters.ts:23`                                                    | Current                   | Low      |
| Slack                     | Web API methods                                     | `SlackApiClient.ts:97,157`, `SlackConnectionService.ts:88`                | Current                   | Medium   |
| xAI                       | `/v1`                                               | `endpoints.ts:13`                                                         | Current                   | Low      |
| Z.ai                      | `/api/anthropic`                                    | `models.ts:105`                                                           | Current                   | Low      |
| Zeplin                    | `/v1`                                               | `ZeplinProvider.ts:38,98-184`                                             | Current                   | Low      |

Counts: 3 Broken, 2 Deprecated-with-a-date, 1 Unverifiable, 10 Drifting, 18 Current.

Severity is ours, not the vendor's: breaks a run path with no fallback is High, an optional
integration degrading is Medium, ergonomics is Low. A **Current** row can still carry High
severity: that is the blast radius if it ever moves, which is why GitLab, Jira and the OIDC client
sit there.

## Since the last sweep

This is the first sweep, so there is no diff to read. The record is regenerated wholesale on every
run and this line is what the next one reads to build its own diff.

The `check-external-api-inventory.mjs` guard, added in `97da5e99d`, means a surface classified
nowhere fails the pull request that adds it. So an integration landing between sweeps cannot sit
unswept for months, which is the half a periodic job structurally cannot cover.

## Per-integration

### Confluence Cloud REST v1: Broken (High)

**What we call.** `ConfluenceProvider.ts:117` reads a page
(`GET {base}/wiki/rest/api/content/{id}?expand=version` for the cheap staleness probe, and the
same path with `expand=body.storage,version` for the full read); `:164` searches
(`GET {base}/wiki/rest/api/content/search?cql=...&limit=20`). HTTP Basic over account email plus
API token.

**Verdict.** The content-by-id path is **retired**. Atlassian's RFC-19 deprecated the Confluence
Cloud REST v1 endpoints, and staff confirmed on 2025-04-01 that "all other deprecated v1 APIs will
still be retired on **April 30, 2025**" (children/descendants alone were extended to 2025-09-30).
`GET /wiki/rest/api/content/{id}` is now **absent from the v1 reference**: two independent reads of
the Content group list only Archive pages, Publish shared draft, Publish legacy draft, and Search
content by CQL. Read 2026-08-18:
[RFC-19](https://community.developer.atlassian.com/t/rfc-19-deprecation-of-confluence-cloud-rest-api-v1-endpoints/71752),
[timeline thread](https://community.developer.atlassian.com/t/update-to-confluence-v1-api-deprecation-timeline/79687?page=2),
[v1 Content group](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content/).

**The CQL search survives**, and there is deliberately **no v2 equivalent**: v2 has no search
endpoint at all, so search stays on v1 (`GET /wiki/rest/api/content/search`, which RFC-19 did not
list). Its own narrower deprecation drops `user`, `user.fullname`, `user.accountid` and
`user.userkey` from CQL input, and caps `limit` at 25 when expanding `body.export_view` or
`body.styled_view`. So the fix splits: two calls move to v2, one stays.

**Replacements**, read 2026-08-18:

| Ours                         | v2                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| page-by-id with body         | `GET /wiki/api/v2/pages/{id}?body-format=storage` ([page group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/))                                                              |
| version-only staleness probe | `GET /wiki/api/v2/pages/{id}/versions`, or read `version.number` off the page with `body-format` omitted ([version group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-version/)) |
| CQL search                   | no v2 equivalent; stays on v1                                                                                                                                                                           |

`expand=body.storage` maps cleanly onto `body-format=storage` (`atlas_doc_format` is the other
accepted value). v2 also replaces v1's offset paging with `cursor`/`limit`.

### MCP protocol handshake: Broken (High)

**What we call.** `mcpProbe.ts` is a hand-rolled JSON-RPC 2.0 client over Streamable HTTP that
probes an arbitrary third-party tool server: `initialize` pinned to `PROBE_PROTOCOL_VERSION =
'2025-11-25'` (`mcpProbe.ts:52`), refusing a server that answers without a `protocolVersion` or
`serverInfo`; then the negotiated version echoed as `mcp-protocol-version`, an `mcp-session-id`
captured and echoed, `notifications/initialized`, then paged `tools/list`.

**Verdict.** `2025-11-25` is not current. The spec publishes `2024-11-05`, `2025-03-26`,
`2025-06-18`, `2025-11-25` and `2026-07-28`, and **`2026-07-28` is what `/specification/latest`
serves**. That revision deletes the machinery our probe is built on:

- **Sessions and `Mcp-Session-Id` are removed** (SEP-2567).
- **`initialize` and `notifications/initialized` are deleted** (SEP-2575). Protocol version,
  `clientInfo` and `clientCapabilities` now ride `_meta` on _every_ request
  (`io.modelcontextprotocol/protocolVersion` and siblings), and `serverInfo` comes back in each
  result's `_meta`.
- Servers **MUST** implement a new `server/discover` RPC for versions, capabilities and identity.
- Two headers are now **required** on every POST: `Mcp-Method`, plus `Mcp-Name` for
  `tools/call` / `resources/read` / `prompts/get`, both validated against the body under penalty of
  `-32020 HeaderMismatch`.

The spec's own compatibility matrix rates Legacy client to Modern server as **"Fails"**, noting
that "legacy clients have no fall-forward mechanism". Read 2026-08-18:
[latest](https://modelcontextprotocol.io/specification/latest),
[2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

**The honest nuance**: whether a given third-party server has dropped the legacy handshake is that
server's choice, not the spec's, so some servers still answer us. What is settled is that the spec
has moved, our era-combination is documented as failing, and we have no fall-forward. `tools/list`
pagination itself is unchanged (`params.cursor` to `result.nextCursor`).

`MCP-Protocol-Version` is still required and that is the documented casing; its value MUST equal
the body's `io.modelcontextprotocol/protocolVersion`. A server supporting pre-`2025-06-18` clients
MAY treat a missing header as `2025-03-26`, otherwise it MUST reject.

### incident.io: Broken (Medium)

**What we call.** `IncidentIoEnrichmentProvider.ts:52` posts the investigation as an incident
update: `POST {base}/v2/incident_updates` with `{ incident_id, message }`, throwing on any non-ok
response. `:76` finds the live incident with `GET {base}/v2/incidents`, paging on `after` and
filtering client-side.

**Verdict.** `POST /v2/incident_updates` **does not exist**. incident.io's tag spec defines exactly
one operation on that path, `GET /v2/incident_updates` ("Incident Updates V2_List"), and there is no
create operation for incident updates at **any** version: no `incident-updates-v1` create, no
`incidents-v3`. Verified twice, independently, read 2026-08-18:
[incident-updates-v2.json](https://docs.incident.io/openapi/tags/incident-updates-v2.json),
[llms.txt](https://docs.incident.io/llms.txt),
[list reference](https://docs.incident.io/api-reference/incident-updates-v2/list.md).

**Why nobody noticed.** `gates.ts:342-349` wraps the call in a bare `try/catch {}` whose comment
says a failing enrichment must not block the run. That disposition is right; the empty catch is
not. It binds no cause, so a capability that has never worked reads exactly like a deployment with
no incident tool configured. CLAUDE.md's rule covers this: a best-effort path swallows, and it
still names the operation with the cause attached.

**The open question this sweep could not answer**: what replaces it. There is no public endpoint
for privately annotating an incident. `status-page-incident-updates-v2/create` publishes to the
customer-facing status page, which is precisely the re-alerting this integration must not do, and
`alert-notes-v1/create` attaches to alerts rather than incidents. So the fix needs a design
decision, not just a path swap.

**Otherwise sound, with drift.** `GET /v2/incidents` is current, and v2 is the current version for
incidents (v1 is marked deprecated; v3 exists only for catalog, alert-routes and teams). Pagination
is `page_size` (default 25, **max 250**) plus an `after` cursor, which matches ours. But our code
comment claims the `status` filter "keys on workspace-specific status ids, not categories", so we
page and filter client-side; the documented filters are operator objects including
**`status_category[one_of]`**, which is exactly the server-side narrowing we believed unavailable.
Also: listing incidents is rate-limited to **60/min** against a 1,200/min default, and every
response carries `X-RateLimit-*` with `Retry-After` on 429.

### Langfuse: Deprecated with a date, 2026-11-16 (Medium)

**What we call.** `observability-langfuse/src/index.ts:95` posts `{ batch: [...] }` to
`{base}/api/public/ingestion` with HTTP Basic (public key as username, secret as password). Event
types are `trace-create`, `generation-create` and `span-create`.

**Verdict.** "The OpenTelemetry endpoint is the supported path for trace ingestion. The legacy
Ingestion API is deprecated and is sunset on Langfuse Cloud on **November 16, 2026**", and it is
unavailable on self-hosted v4 in default mode. Worse for us: "Trace, span, and generation events
via the legacy batch ingestion API are **not supported on the v4 data model**", which covers all
three of our types. Read 2026-08-18: [API](https://langfuse.com/docs/api),
[compatibility](https://langfuse.com/docs/compatibility).

This is the pin scheme the sweep's own grep was widened for: the path carries **no version
segment**, so nothing a version check could look at would have caught this.

**The replacement is already in the tree.** Langfuse accepts OTLP over HTTP with both `HTTP/JSON`
and `HTTP/protobuf` at `{base}/api/public/otel/v1/traces`, same Basic auth, plus a header
`x-langfuse-ingestion-version: 4` (without which v4 data lands up to 10 minutes late). We hand-wrote
an OTLP/HTTP **JSON** exporter in `@cat-factory/observability-otel`, so the migration retargets an
existing encoder rather than writing one.
[OpenTelemetry integration](https://langfuse.com/integrations/native/opentelemetry) (read 2026-08-18).

Rate limits are per organisation on the tracing bucket (Hobby 1,000/min, Core 4,000, Pro and above
20,000), and a 429 carries `Retry-After` in seconds, which our drop-and-warn path ignores.
[API limits](https://langfuse.com/faq/all/api-limits) (read 2026-08-18).

### GitHub REST: Deprecated with a date, 2028-03-10 (Low)

**What we call.** `x-github-api-version: 2022-11-28` plus `accept: application/vnd.github+json`,
from **fourteen** non-test files. Five reach the pin through an `API_VERSION` identifier, and even
those are four separate constants: `githubHttpHelpers.ts:118` exports one that
`FetchGitHubClient.ts:1229` and `viewerTokenReads.ts:113` import, while `GitHubAppAuth.ts:213`,
`FetchGitHubProvisioningClient.ts:58` and `auth/GitHubOAuth.ts:93` each declare a private one. The
other nine carry the literal inline:

```
backend/internal/acceptance/src/repoContentApi.ts:70
backend/internal/acceptance/src/vcsIssues.ts:188
backend/internal/executor-harness/src/vcs-api.ts:266,460,495
backend/packages/integrations/src/modules/providers/githubPatCapability.ts:96
backend/packages/integrations/src/modules/providers/userSecretKinds.ts:101
backend/packages/integrations/src/modules/tracker/github.create.logic.ts:34
backend/packages/server/src/github/ensureWorkBranch.ts:55
backend/packages/server/src/github/GitHubIdentityResolver.ts:52,94
backend/runtimes/local/src/github.ts:125
```

The two under `backend/internal/acceptance/` are not fakes mirroring a pin: they **send** it, to
`ACCEPTANCE_VCS_API_BASE ?? https://api.github.com`. Counting the constants and stopping would
reach five of the fourteen files a version move must touch, and one of them
(`executor-harness/src/vcs-api.ts`) bumps the runner image.

**Verdict.** `2022-11-28` is still supported and is still the default for a request that omits the
header, with an announced end of support of **March 10, 2028**. A successor `2026-03-10` shipped on
2026-03-10 and is itself "Not yet scheduled" for retirement. Recorded as Deprecated-with-a-date
rather than Current because a dated end of support is a sunset announcement, which is what a later
sweep needs to see in the diff. Read 2026-08-18:
[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions),
[changelog](https://github.blog/changelog/2026-03-12-rest-api-version-2026-03-10-is-now-available/).

**Do not move the pin casually.** GHES 3.20 supports **only** `2022-11-28`, so our pin stays correct
for the `/api/v3` and `ACCEPTANCE_VCS_API_BASE` targets
([GHES 3.20](https://docs.github.com/en/enterprise-server@3.20/rest/about-the-rest-api/api-versions),
read 2026-08-18). And `2026-03-10` is the first calendar version carrying breaking changes, three of
which touch endpoints we call: `merge_commit_sha` removed from pull-request responses, the singular
`assignee` field removed from issue and PR endpoints, and `GET /contents/{path}` returning
`type: "submodule"` instead of `"file"` for a submodule
([breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10),
read 2026-08-18).

**The highest-risk endpoint is fine.** `GET /search/issues` is **not** deprecated and our
unparameterised call behaves exactly as before: `advanced_search` is still an optional query
parameter with no default and no retirement date. Nothing announces that advanced search became the
only behaviour. What changed is additive: a `search_type` parameter (`semantic` | `hybrid`) went GA
on 2026-04-02, and "when not specified, the default is lexical search". One trap if we ever opt in:
with `advanced_search=true`, a space between multiple `repo`/`org`/`user` qualifiers means **AND**
where today it means **OR**. Read 2026-08-18:
[search](https://docs.github.com/en/rest/search/search?apiVersion=2026-03-10),
[GA changelog](https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/).

Sub-issues (`/repos/{o}/{r}/issues/{n}/sub_issues`) need no preview media type and no non-default
version; the OpenAPI entries carry an empty `previews` list and no `deprecated` flag
([sub-issues](https://docs.github.com/en/rest/issues/sub-issues), read 2026-08-18). Nothing else in
our endpoint list is removed or relocated, including `/commits/{ref}/check-runs`, `POST /merges` and
`/pulls/{n}/requested_reviewers`.

Rate limits: GitHub returns `x-ratelimit-*` plus `retry-after` on a secondary limit, and documents
that a caller should not retry before `x-ratelimit-reset`
([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
read 2026-08-18). Worth checking our bounded-page pagination reads `retry-after`.

### npm registry: Unverifiable (Low)

**What we call.** `scripts/check-release-versions.mjs:88` reads
`https://registry.npmjs.org/{name}` with a scoped name's `/` encoded as `%2f`.

**Verdict.** `GET /{package}` is confirmed as the documented packument endpoint
([REGISTRY-API.md](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md), read
2026-08-18). But that page covers **none** of: the `%2f` scoped-name encoding, the
`application/vnd.npm.install-v1+json` abbreviated-metadata form, rate limits, or a user-agent
policy, and no page settling them was located. Filed as Unverifiable rather than folded into
Current: an unchecked call and a checked-and-correct call are different facts, and our `%2f`
encoding plus the payload size we accept are both unverified.

What would settle it: `npm/registry`'s `docs/responses/package-metadata.md` (the file
`REGISTRY-API.md` defers to), or an observed
`curl -sI -H 'Accept: application/vnd.npm.install-v1+json' https://registry.npmjs.org/@scope%2fname`
showing the content type honoured and a payload delta.

### Google OAuth / OpenID Connect: Drifting (High)

**What we call.** `GoogleOAuth.ts` is hand-rolled, not SDK-mediated: authorize at
`https://accounts.google.com/o/oauth2/v2/auth` (`:56`), token at
`https://oauth2.googleapis.com/token` (`:7`, `:75`), userinfo at
`https://www.googleapis.com/oauth2/v3/userinfo` (`:88`).

**Verdict.** Compared against Google's own discovery document at
`https://accounts.google.com/.well-known/openid-configuration` (read 2026-08-18), verbatim:

| Ours                                            | Google publishes                                                           |                             |
| ----------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| `https://accounts.google.com/o/oauth2/v2/auth`  | `"authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth"` | match                       |
| `https://oauth2.googleapis.com/token`           | `"token_endpoint": "https://oauth2.googleapis.com/token"`                  | match                       |
| `https://www.googleapis.com/oauth2/v3/userinfo` | `"userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo"`  | **different host and path** |

Google's OIDC guide and API reference document **only** `openidconnect.googleapis.com/v1/userinfo`;
neither mentions our path, and neither carries a deprecation notice for it. So Google does not say
the old path still answers and does not say it stopped. Drifting rather than Broken because no fetch
proved it dead, but it is an undocumented endpoint carrying every Google sign-in, which is why the
severity is High. Read 2026-08-18:
[OIDC guide](https://developers.google.com/identity/openid-connect/openid-connect),
[reference](https://developers.google.com/identity/openid-connect/reference).

The `www.googleapis.com` host itself is still live in Google's OAuth surface: the same discovery
document gives `"jwks_uri": "https://www.googleapis.com/oauth2/v3/certs"`, so this is a path move,
not a host retirement.

No deprecation affects the authorize or token endpoints; the only one named on the web-server flow
page is the out-of-band `redirect_uri` flow, "deprecated and is no longer supported". Discovery
advertises `"code_challenge_methods_supported": ["plain","S256"]`, so PKCE is available and not
documented as required
([web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), read
2026-08-18). All five claims we read off userinfo (`sub`, `email`, `email_verified`, `name`,
`picture`) are documented, with the caveat that `name` and `picture` are "never guaranteed to be
present".

### Datadog: Drifting (Medium)

**What we call.** `DatadogClient.ts:101` reads a monitor (`GET /api/v1/monitor/{id}`), `:122` an
SLO history (`GET /api/v1/slo/{id}/history?from_ts=&to_ts=`), `:153` a logs aggregate
(`POST /api/v2/logs/analytics/aggregate`). Auth is `DD-API-KEY` plus `DD-APPLICATION-KEY`, and the
base host is deployment-supplied.

**Verdict.** All three endpoints are current, GA and undeprecated at the versions we call, and the
header pair is right for both v1 and v2. There is no v2 replacement for monitor details, and
`GET /api/v2/slo/{slo_id}/status` is marked `x-unstable`, so it is not a GA successor. Evidence is
Datadog's published OpenAPI schemas (`DataDog/datadog-api-client-typescript`,
`.generator/schemas/v1/openapi.yaml` and `v2/openapi.yaml`, last committed 2026-08-14), read
2026-08-18, because the rendered reference pages are JS-built and returned only endpoint lists to a
fetcher.

**The drift is a field that does not exist.** `DatadogClient.ts:100` declares and `:102` parses
`overall_state_modified`, which is **not** in Datadog's current v1 `Monitor` schema (it appears only
on Synthetics v2 schemas). So `stateModifiedMs` is silently always `undefined`, and the
post-release-health gate reports no state-change time at all. The documented timestamps are per
group at `state.groups.<group>.last_triggered_ts` / `last_resolved_ts` / `last_notified_ts` /
`last_nodata_ts` (epoch seconds), and `state` is only populated when the request passes
**`group_states`** (`all`, `alert`, `warn`, `no data`), which we never send.

Everything else we read checks out. `overall_state` is correct, enum
`Alert | Ignored | No Data | OK | Skipped | Unknown | Warn`, and needs no query parameter. `from_ts`
and `to_ts` are both still required and still **epoch seconds**. The SLI value is
`data.overall.sli_value` and is explicitly `nullable: true`, so our null tolerance is documented
rather than defensive; the target is `data.thresholds.<timeframe>.target`, which confirms the
per-timeframe `pickSloTarget` read. The logs-aggregate body keys `compute`, `filter` and `group_by`
are all current, and inside `group_by` the `limit` **defaults to 10**, so our top-N depends on us
setting it. Scopes: `monitors_read` and `slos_read`; logs aggregate declares
`x-permission: logs_read_data` but no operation-level AuthZ scope.

Per CLAUDE.md's degrade-loudly rule this is the wrong failure shape twice over: a field that cannot
resolve renders identically to a monitor that has never changed state. The fix is to pass
`group_states=all` and fold `state.groups[*].last_triggered_ts`, or to stop reporting a state-change
time rather than reporting a permanently absent one.

### Figma: Drifting (Medium)

**What we call.** `FigmaProvider.ts:612` reads design variables
(`GET /v1/files/{key}/variables/local`, whose `meta` payload we parse), `:635` renders images
(`GET /v1/images/{key}?ids=&format=png`, one call for many node ids). OAuth lives in
`figma.logic.ts:63-65`: authorize `https://www.figma.com/oauth`, token
`https://api.figma.com/v1/oauth/token`, refresh `https://api.figma.com/v1/oauth/refresh`, scopes
`file_content:read` and `file_variables:read` joined with commas, HTTP Basic client auth.

**Verdict.** Paths, shapes, scopes and the Basic token exchange are all confirmed current, with two
items of drift. All read 2026-08-18.

1. **The refresh endpoint is superseded.** "Previously, you used the
   `https://api.figma.com/v1/oauth/refresh` endpoint... Now, when you refresh your OAuth tokens, you
   should use the `https://api.figma.com/v1/oauth/token` endpoint." Legacy is "supported for now"
   with no retirement date
   ([oauth-apps](https://developers.figma.com/docs/rest-api/oauth-apps/),
   [changelog 2025-05-16](https://developers.figma.com/docs/rest-api/changelog/)). Note the
   authorize URL has **not** moved, and our token host is already on the current side of an earlier
   move.
2. **Non-expiring PATs can no longer be created (90-day maximum).** That will break the PAT path on
   a clock rather than on a deploy. The answer Figma ships is **plan access tokens** (GA
   2026-07-23), which are org-scoped and independent of an individual user
   ([changelog](https://developers.figma.com/docs/rest-api/changelog/)).

Confirmed correct: both endpoint shapes (`variables/local` returns `meta` with `variables` and
`variableCollections` dictionaries; `/v1/images` takes a comma-separated id list and returns a map
of id to URL); `variables/local` is still Enterprise-only and still 403s below it; both scope names,
with a warning that the neighbours `files:read`, `projects:read` and `project_metadata:read` are
deprecated, so a fallback to `files:read` is not available; and scopes may be space- **or**
comma-separated, so our commas are fine. One caveat on the 403: Figma documents it for
`Limited by Figma plan`, `Incorrect account type` **and** `Invalid scope`, so treating it as a bare
plan gate can mask a broken credential
([variables-endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/),
[scopes](https://developers.figma.com/docs/rest-api/scopes/)).

### Google Gemini (Nano Banana): Drifting (Medium)

**Why this one is unusual.** `nano-banana.openapi.ts` hand-writes an OpenAPI 3.1 document for
Google's Interactions API and the registry renders it into `.cat-context/` for an **LLM agent**,
which composes and sends the request from that document and nothing else. Every name and number
transcribed into it is sent verbatim by something that never reads a vendor page, and the file's own
header lists what "will go stale without failing anything" and asks for exactly this re-read.

**Verdict.** The load-bearing skeleton verifies exactly. The server, `POST /v1beta/interactions`,
`x-goog-api-key` as a header rather than `?key=`, all three model ids, the four `image_size` values
with our per-model split (lite 1K only, pro no 512px, flash all four), all ten aspect ratios,
`output_image` / `output_text` / `usage` as inline base64, SynthID on every generated image, the five
input mime types and two output types, and both headline price ranges. Google does **not** steer
image generation to `generateContent`: "The Interactions API is now generally available. We
recommend using this API for access to all the latest features and models." Read 2026-08-18:
[image-generation](https://ai.google.dev/gemini-api/docs/image-generation),
[interactions reference](https://ai.google.dev/api/interactions-api),
[image-understanding](https://ai.google.dev/gemini-api/docs/image-understanding),
[pricing](https://ai.google.dev/gemini-api/docs/pricing),
[api-errors](https://ai.google.dev/gemini-api/docs/api-errors),
[api-versions](https://ai.google.dev/gemini-api/docs/api-versions).

**Five things are wrong, and an agent sends four of them verbatim.**

| Ours                                                                                             | Documented                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinking_level` enum `minimal`, `low`, `medium`, `high`                                         | "The default `thinking_level` is `minimal`, and the supported levels are `minimal` and `high`", documented only for `gemini-3.1-flash-image`. `low` and `medium` are inventions an agent will send.           |
| "up to 14 reference images, pro reads roughly six objects, five characters and three style refs" | Lite: up to 14 objects. Flash: 10 objects + 4 characters + 3 style. **Pro: 6 objects + 5 characters, no style references.** The 3 style refs are Flash's, and 14 is Lite's cap rather than a universal total. |
| invalid API key returns 400 `INVALID_ARGUMENT`                                                   | **401 `UNAUTHENTICATED`**. `INVALID_ARGUMENT` is payload-only; `PERMISSION_DENIED` 403 is a valid key lacking entitlement. We declare no 401 response at all.                                                 |
| lite `$0.034` per image, and "$60 / $120 per 1M output tokens"                                   | `$0.0336` (harmless rounding), but the rate list is **incomplete**: lite is **$30/1M**, which we never state.                                                                                                 |
| `v1beta` is the current segment                                                                  | "The Interactions API and its core features are generally available in `v1`." The reference page we transcribed from banners itself: "**Beta**: You are viewing the beta version."                            |

Flash and pro prices verify exactly (flash 0.5K $0.045, 1K $0.067, 2K $0.101, 4K $0.151; pro $0.134
for 1K and 2K, $0.24 for 4K), as does the 1K default. Our deliberate exclusions (grounding tools,
streaming, `background` execution, stored multi-turn) remain right, and the grounding-billing
warning in the header still earns its place.

One claim in our document could not be confirmed either way and matters most, because it drives the
instruction "check that you got an image": we tell the agent a declined request answers **200 with a
text block and no image**. No page read this session documents the Interactions API's refusal shape,
and `api-errors` frames blocked generations as error codes (`safety`, `prohibited_content`,
`image_safety`, `recitation`, `blocklist`, `spii`), which contradicts us, though it is written
against the older surface.

### Linear: Drifting (Medium)

**What we call.** `linear.client.ts:16` posts to the single endpoint
`https://api.linear.app/graphql`. Auth is the subtle part and it is **correct**: a personal API key
goes as the raw `authorization` header value with no `Bearer` prefix, an OAuth token as
`Bearer <token>` (`:34`). Documents are hand-written in `linear.logic.ts`: the intake and candidate
`issues(filter:, first:, after:, sort: [{ createdAt: { order: Ascending } }])` queries (`:113`,
`:423`), `LINEAR_TEAMS_QUERY` with `teams(first: 250)` (`:187`), `LINEAR_VIEWER_QUERY` (`:190`), a
single-issue read, and issue and comment creation.

**Verdict.** Every operation, field and auth scheme verified live and non-deprecated against
Linear's published schema (last committed 2026-08-13) and its docs, read 2026-08-18. Two items of
drift.

1. **`sort` is annotated `[INTERNAL]`.** Our shape and enum spelling are byte-correct
   (`Query.issues` accepts `sort: [IssueSortInput!]`, `CreatedAtSort { nulls, order }`,
   `enum PaginationSortOrder { Ascending Descending }`) and carry no `@deprecated`. But the schema
   documents the argument as "[INTERNAL] Sort returned issues", while `orderBy: PaginationOrderBy`
   is the one the docs actually document. There was no `orderBy` to `sort` migration: both coexist.
   Nothing is broken and no deadline exists, but we depend on an argument the vendor marks internal.
   The cheap hedge is a fallback to the documented `orderBy: createdAt`, which yields the same
   ascending-by-creation order.
   ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql),
   [pagination](https://linear.app/developers/pagination))
2. **Rate-limit exhaustion is HTTP 400 with an error `code` of `RATELIMITED`, not 429**, and
   `Retry-After` is not documented. A status-code-only retry check misses it entirely. The headers to
   honour are `X-RateLimit-Requests-*` and `X-RateLimit-Complexity-*` (resets in UTC epoch
   **milliseconds**), against 5,000 requests/hour plus 3,000,000 complexity points/hour for a
   personal key. ([rate limiting](https://linear.app/developers/rate-limiting))

Confirmed: the raw un-prefixed key header is still documented with no deprecation and no deadline
([graphql](https://linear.app/developers/graphql), [oauth](https://linear.app/developers/oauth-2-0-authentication));
no renames or new required arguments on anything we send, and `IssueFilter` carries zero
`@deprecated` fields, with `labels`, `assignee` and `state` all present under current names; none of
issue `description`, issue `labels`, `PageInfo.endCursor` or `Team.key` is deprecated, though the
schema does carry 79 `@deprecated` markers elsewhere (`Team.private` to `Team.visibility`,
`Issue.boardOrder` to `sortOrder`). `CommentConnection` still exposes **no** `totalCount`, so our
bounded comment count is the only available answer and reporting its cap is correct.

On `first: 250`: no maximum page size is published anywhere, so it cannot be confirmed as within a
documented cap. The real constraint is complexity against a 10,000-point single-query ceiling, and
`teams(first: 250) { nodes { id name key } }` is roughly 325 points, comfortably clear.

### MCP authorization: Drifting (Medium)

**What we call.** `mcpOAuthClient.ts` is hand-rolled on `fetch`. As a client it walks
protected-resource metadata at `{origin}/.well-known/oauth-protected-resource{path}` then the bare
path (`:212-213`), then authorization-server metadata at
`{origin}/.well-known/oauth-authorization-server{path}`,
`{origin}{path}/.well-known/oauth-authorization-server`, and
`{origin}{path}/.well-known/openid-configuration` (`:241-243`). Then token calls for
`authorization_code`, `refresh_token` and `client_credentials`. As a server we publish
`/.well-known/oauth-protected-resource{ourMcpPath}`, the bare path, and
`/.well-known/oauth-authorization-server`.

**Verdict.** The required documents are still exactly these; MCP servers MUST implement RFC 9728 and
clients MUST use it. Our **protected-resource** order (path-insert, then root) matches the
documented fallback, and RFC 9728 §3.1 confirms the insert form. Read 2026-08-18:
[AS discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery),
[RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728),
[RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414),
[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).

**Our authorization-server order is wrong in two ways.** The documented order for an issuer with a
path is (1) `/.well-known/oauth-authorization-server/{path}`, (2)
`/.well-known/openid-configuration/{path}` (the OIDC **path-insert** form), (3)
`{path}/.well-known/openid-configuration` (the OIDC **append** form). We are **missing (2)
entirely**, and our second probe (`{origin}{path}/.well-known/oauth-authorization-server`) is **not
a documented location**. We also do not appear to make the RFC 8414 §3.3 `issuer`-equality check on
the fetched document.

**Checked and correct, contrary to the initial worry.** RFC 8707 resource indicators are
**mandatory** ("MUST be included in both authorization requests and token requests... regardless of
whether authorization servers support it"), and PKCE is inherited as a MUST from OAuth 2.1. We
comply on both: `resource` is set on the authorize URL (`mcpOAuthClient.ts:294`) and in the shared
`tokenRequest` body (`:373`), so it rides every grant including refresh and client credentials, and
`code_challenge` with `code_challenge_method=S256` is sent (`:289-290`) with the verifier on
exchange (`:318`). `client_credentials` is also sanctioned rather than out of scope: the spec
addresses "clients acting on their own behalf".

**DCR has changed underneath us, favourably.** Dynamic Client Registration is now **deprecated**
("MAY support RFC 7591... retained for backwards compatibility"), superseded by **Client ID Metadata
Documents**, which clients and servers SHOULD support, advertised via
`client_id_metadata_document_supported`. Registration priority is pre-registered, then CIMD, then
DCR, then prompt the user. So not implementing DCR is no longer the blocking gap; not implementing
CIMD is the forward-looking one, and pre-registration alone leaves no path to a server we have no
relationship with.

Also newly binding and not implemented: a client MUST record the AS `issuer` and validate a present
`iss` (RFC 9207) before redeeming the code, and as a resource server we now owe a `WWW-Authenticate`
`scope` parameter and `403 insufficient_scope` step-up challenges.

### Notion: Drifting (Low)

**What we call.** `NotionProvider.ts:20-22` pins `notion-version: 2022-06-28` against a fixed
`https://api.notion.com/v1`. `:172`/`:199` read a page (`GET /v1/pages/{id}`, taking `id` and
`last_edited_time`), `:251` walks block children
(`GET /v1/blocks/{id}/children?page_size=100&start_cursor=`, paging on `has_more` and `next_cursor`
with a bounded page count), `:208` searches (`POST /v1/search` with
`filter: { property: 'object', value: 'page' }` and `page_size: 20`).

**Verdict.** Nothing we send is broken and there is **no sunset**: the versioning page says "We
don't currently have any plans to stop supporting older API versions. If this changes in the future,
we'll communicate this with all affected users and provide a time window and migration guidance."
Only the JS SDK dropped `2022-06-28`, not the REST API. But we are four documented versions behind
the current `2026-03-11`. Read 2026-08-18:
[versioning](https://developers.notion.com/reference/versioning).

**Moving the pin is safe for what we read and would unlock a lot.** `2025-09-03` split databases
into data sources: `GET /v1/pages/{id}` is structurally unchanged (`parent` gains a
`data_source_id`), and `POST /v1/search` changes only the _database_ half of the filter
(`value: "database"` becomes `"data_source"`), so our page-only filter and page-only keep are
unaffected. `2026-03-11` breaks three things, none of which we touch: `archived` becomes `in_trash`
on pages and blocks, `after` becomes a write-only `position` object, and block type `transcription`
becomes `meeting_notes`. None of `id`, `last_edited_time`, `results[]`, `has_more` or `next_cursor`
changed. Read 2026-08-18:
[2025-09-03 upgrade](https://developers.notion.com/docs/upgrade-guide-2025-09-03),
[2026-03-11 upgrade](https://developers.notion.com/docs/upgrade-guide-2026-03-11).

Both endpoint shapes are current: `page_size: 20` is within the 100 default and maximum on search,
100 is still the max on block children, and the filter value `page` is still valid. Bearer is still
correct. Rate limits are about 3 requests/second per connection, and the docs are explicit that a
connection "should handle HTTP 429 **and 529** responses and respect the `Retry-After` response
header" (529 is named alongside 429, which our path does not distinguish). Read 2026-08-18:
[request limits](https://developers.notion.com/reference/request-limits),
[block children](https://developers.notion.com/reference/get-block-children),
[search](https://developers.notion.com/reference/post-search).

### OpenRouter: Current (Low)

**What we call.** `OpenRouterCatalogService.ts:30` sets
`OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'`; `refresh` probes `/models` with a leased
pooled key as `Bearer` and `openRouterModels.ts` reads the payload, converting USD per token to
per-million. `/api/v1/chat/completions` is reached two ways: inline through
`@openrouter/ai-sdk-provider`, and from a container agent through the LLM proxy's forward path.

**Verdict.** Path, auth, field names and the unit are all unchanged. The unit was verified
explicitly because getting it wrong is a 1,000,000x cost-display error: pricing is "in USD per
token/request/unit", as **strings** (the string form avoids float precision loss, and `"0"` means
free). No per-million conversion has crept in. Read 2026-08-18:
[models list](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
[models overview](https://openrouter.ai/docs/guides/overview/models).

**The drift was what we dropped, and most of it is now read** (2026-09-01, this sweep's
follow-up): `parseOpenRouterModels` takes `canonical_slug`, `expiration_date` and the full pricing
shape: `discount`, `input_cache_read`, `input_cache_write` / `input_cache_write_1h`, and the
conditional `overrides` bands, folded to their MAXIMUM because which band applies depends on the
prompt length and the wall clock at call time and a budget may only be wrong upward. The cache
rates reach the spend table through `withDynamicPrices`; `expiration_date` reaches the catalog
picker, because a withdrawn pin fails silently (the route stops answering and the run takes the
next one). `scripts/check-openrouter-pins.mjs` re-reads the live catalogue against the ~20
`openrouter:<slug>` rows in the spend table; its first run found three pins understating the live
rate, one of them (`deepseek/deepseek-v4-pro`) by nearly 3x.

Still dropped, deliberately: `supported_parameters`, `architecture.*`, `created`, `top_provider`,
`per_request_limits`, `default_parameters`, `benchmarks`, and the non-text pricing classes
(`request`, `image*`, `audio*`, `web_search`, `internal_reasoning`, `input_audio_cache`). Nothing
here meters them yet. `/models` also takes `offset`/`limit` (max 1000; omitting both returns the
full list) plus `category`, `q`, `sort`, `min_price`/`max_price`; we read the full list, which is
what the pin check and the browse picker both want.

**We now also SEND two things we did not.** `usage: { include: true }` turns on usage accounting,
so a reply carries the gateway's own `cost` and the `provider` it routed to (recorded on
`llm_call_metrics`; see [`llm-telemetry.md`](../../backend/docs/llm-telemetry.md)), and
`provider: { require_parameters, data_collection }` constrains routing. Both ride the inline path
(`openRouterResolver`) and the container proxy through one module, `gateway-attribution.ts`.

### GitLab REST v4: Current (High)

**What we call.** `FetchGitLabClient.ts` plus `GitLabIdentityResolver.ts`, `provisioning.ts`,
`reviewPosting.ts` and `projection.ts`, against `https://gitlab.com/api/v4` or a self-managed base.
Auth `PRIVATE-TOKEN`; `Link`-header pagination with a bounded page cap. Projects, repository
branches/commits/files/tree, commit statuses, merge requests with approvals, discussions, notes,
merge and rebase, issues, groups, namespaces, `GET /user`.

**Verdict.** `/api/v4` is the live REST version and the deprecations page is explicit: "Though some
deprecations mention a v5 REST API, no v5 REST API development is active". `PRIVATE-TOKEN` is still
documented and recommended for PATs, with Bearer as an alternative and no deprecation. Every
endpoint we call is documented without deprecation except two, both deprecated-but-present with
removal targeted only at that non-existent v5. Read 2026-08-18:
[REST](https://docs.gitlab.com/api/rest/),
[REST deprecations](https://docs.gitlab.com/api/rest/deprecations/),
[authentication](https://docs.gitlab.com/api/rest/authentication/).

**Keep the `/changes` fallback.** `FetchGitLabClient.ts:601-620` tries the paginated `/diffs` and
falls back to `/changes` on a 404, for instances predating GitLab 15.7. `/changes` is deprecated with
removal targeted at v5 and "no date is set", so the fallback is still live and still needed.

**One thing to fix, and it is a CLAUDE.md pattern.** `merge_status` was deprecated in 15.6 in favour
of `detailed_merge_status`, removal targeted at v5 only, and the value set has **grown** since:
beyond `mergeable`, `conflict`, `ci_still_running`, `discussions_not_resolved` and `draft_status` it
now includes `security_policy_pipeline_check`, `security_policy_violations`, `approvals_syncing`,
`merge_time`, `jira_association_missing`, `not_open`, `commits_status` and `merge_request_blocked`.
This is **not a closed vocabulary**, so an exhaustive `Record` or `switch` over it will meet an
unmapped value: branch on the members we act on and render an unknown one honestly, which is exactly
the retired-enum rule in CLAUDE.md.
([merge requests](https://docs.gitlab.com/api/merge_requests/))

**New limits worth classifying.** GitLab 18.6.2 / 18.5.4 / 18.4.6 added size and rate limits to the
commits and files endpoints returning **413 or 429**, and 18.4.1+ rejects oversized JSON with 400.
Our `RepoFiles` reads should tell those apart from a generic failure
([18.x changes](https://docs.gitlab.com/update/versions/gitlab_18_changes/)). Additive gains:
`/repository/commits/:sha/statuses` took optional `pipeline_id`, `order_by` and `sort` in 17.9, and
`/repository/commits` took `follow` in 18.10 ([commits](https://docs.gitlab.com/api/commits/)).
Offset paging stays the default on everything we call, with a default 50,000 max offset on endpoints
that also support keyset, and no `x-total` above 10,000 records.

**One doc hint is wrong.** `GitLabIdentityResolver.ts:8` references `/auth/pat`, which is not a
documented GitLab path; the real equivalents are `GET /personal_access_tokens/self` and
`/self/associations`
([personal access tokens](https://docs.gitlab.com/api/personal_access_tokens/)).

### Jira Cloud REST v3: Current (High)

**What we call.** `JiraProvider.ts:116` reads an issue, `:193`/`:353`/`:391` search via
`/rest/api/3/search/jql`, `:249` probes with `/myself`, `:327` lists projects via `/project/search`;
`TicketTrackerService.ts:125` files an issue with `POST /rest/api/3/issue`;
`writeback/jira.writeback.ts:88` posts a comment and reads and applies transitions. HTTP Basic over
account email plus API token throughout, against a deployment-supplied site base.

**Verdict.** All nine calls exist and are `deprecated: false` in the live OpenAPI spec
(`info.version 1001.0.0-SNAPSHOT`), there are **410** `/rest/api/3` paths and **zero**
`/rest/api/4`, and `basicAuth` is still a declared security scheme. The only deprecated sibling is
`GET /rest/api/3/search`, flagged "Endpoint is currently being removed": the very endpoint this repo
already migrated off, which is a useful confirmation that the comment in `JiraProvider.ts:388-390`
records a real event. Read 2026-08-18:
[swagger-v3.v3.json](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json),
[changelog](https://developer.atlassian.com/cloud/jira/platform/changelog/),
[basic auth](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).
The legacy removal timeline, corroborated separately: deprecated 2025-05-01, progressive shutdown
2025-08-01 to 2025-10-31, all traffic blocked by end of October 2025
([KB](https://confluence.atlassian.com/jirakb/run-jql-search-query-using-jira-cloud-rest-api-1289424308.html)).

**Basic auth is safe.** `basicAuth` (`type: http, scheme: basic`) remains declared, the auth page
confirms the `email:api_token` construction, and only **password**-based basic auth is deprecated.
No deadline for API tokens and no OAuth migration date. The page's warning that apps collecting API
tokens do not meet Atlassian's app security requirements is a Marketplace-app rule, not ours.

**Two contract details worth acting on.** `/search/jql` pagination is cursor-based on
`nextPageToken` (the response schema `SearchAndReconcileResults` is exactly `isLast`, `issues`,
`names`, `nextPageToken`, `schema`, `warnings`, with **no `total`**, confirming the historical
omission), and that token **expires in 7 days**, which is a latent bug for any long-lived cursor.
And `fields` **defaults to `id`** rather than `*navigable`, so a call omitting it returns ids only.
`maxResults` defaults to 50 and the endpoint returns at most 5,000 issues, so our 100 is well within
cap; on `/project/search` the cap is 100 and a larger value is silently coerced down. `orderBy=name`
is valid there (the enum also has `-name`, `+name`, `category`, `key`, `owner`, `issueCount`,
`lastIssueUpdatedDate`, `archivedDate`, `deletedDate`).

**ADF is still required on v3** for `description`, `environment` and `textarea` custom fields, and
for comment `body`; single-line `textfield` custom fields take a plain string. Required create
fields are still resolved through `/rest/api/3/issue/createmeta`. Transitions are current, with the
note that concurrent transitions now return **409** rather than 400, and a retry is advised
([change notice](https://developer.atlassian.com/cloud/jira/platform/change-notice-update-in-simultaneous-transitions-issue-api/)).
`GET /rest/api/3/myself` is Atlassian's own recommended credential probe, which is what we use it
for.

### Kubernetes: Current (Medium)

**What we call.** `KubernetesApiClient.ts` sends `authorization: Bearer <ServiceAccount token>` with
`accept: application/json` to a deployment-supplied apiserver, and server-side-applies manifests
with `content-type: application/apply-patch+yaml` carrying a raw JSON body.
`kubernetes.logic.ts:191` composes `/api/v1/namespaces/{ns}/pods`;
`kubernetes-environment.logic.ts:169` composes namespace paths. Probes are
`httpGet: { path: '/health', port }`.

**Verdict.** The media type is not a hack: the server-side-apply page states SSA bodies are YAML with
`application/apply-patch+yaml` and adds "Whether you are submitting JSON data or YAML data, use
`application/apply-patch+yaml`". There is **no** `+json` variant; the only sibling is
`application/apply-patch+cbor` when the apiserver enables CBOR. `/api/v1/namespaces/{ns}/pods` is
still the core v1 list path, and the deprecation guide lists no core/v1 Pod or Namespace removal.
`httpGet` still takes `path` and `port`. Read 2026-08-18:
[server-side apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/),
[api-concepts](https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/reference/using-api/api-concepts.md),
[deprecation guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/),
[pod-v1](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/).

**Two dated facts about our own comments.** The oldest supported minor is **1.34** (supported: 1.36
EOL 2027-06-28, 1.35 EOL 2027-02-28, 1.34 EOL 2026-10-27), so `KubernetesApiClient.ts:57`'s
"accepted by every apiserver >= 1.22" is 12 minors behind the floor and now states nothing a
supported cluster could violate ([releases](https://kubernetes.io/releases/)). And our token comes
from a stored secret bundle, which is the legacy shape: since 1.22 Kubernetes mounts short-lived
auto-rotating TokenRequest tokens, permanent per-ServiceAccount Secret tokens stopped being
auto-created in **1.24**, and the gate was removed in **1.27**. Manually created indefinite tokens
still work but are documented as "not recommended", and ours does not rotate
([service accounts](https://kubernetes.io/docs/concepts/security/service-accounts/)).

### OIDC (generic SSO client): Current (High)

**What we call.** `auth/oidc/discovery.ts:97` fetches `{issuerUrl}/.well-known/openid-configuration`
and requires `token_endpoint` and `jwks_uri`, treating `userinfo_endpoint` as optional; `:195` strips
a trailing `/.well-known/openid-configuration` from a configured issuer before composing; the JWKS
is fetched from `jwks_uri` and a key set with no keys is refused. `OidcClient.ts:135` exchanges
`authorization_code`, `:218` verifies the ID token against a local JWK set, `:261` reads userinfo.
The issuer is matched, since accepting a mismatched one would let another issuer's tokens sign in.

**Verdict.** Our composition is correct, including for the case that would most plausibly be wrong.
OpenID Connect Discovery 1.0 §4.1: "If the Issuer value contains a path component, any terminating /
MUST be removed before **appending** `/.well-known/openid-configuration`", with the spec's own
example for issuer `https://example.com/issuer1` being `GET /issuer1/.well-known/openid-configuration`.
RFC 8414 §3 deliberately differs, **inserting** the well-known string between host and path, and says
so explicitly against OIDC. So for `https://idp.example.com/tenant1` the correct OIDC URL is
`https://idp.example.com/tenant1/.well-known/openid-configuration`, which is what we compose, and our
trailing-slash strip is spec-mandated. The issuer match is required by §4.3 and §7.2: "RPs MUST
ensure that the Issuer URL they are using for the Configuration Request exactly matches the value of
the issuer Claim". Read 2026-08-18:
[Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html),
[RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html),
[Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html).

**Three hardening gaps, not drift.** First, we require **less** than the spec: `issuer`,
`authorization_endpoint`, `jwks_uri`, `response_types_supported`, `subject_types_supported` and
`id_token_signing_alg_values_supported` are REQUIRED (`token_endpoint` unless implicit-only), and
`userinfo_endpoint` is only RECOMMENDED, so treating it as optional is right. But we accept a
document missing `issuer`, which is the very field our issuer-match check depends on. Second, PKCE:
OAuth 2.1 draft-15 (2026-03-02) makes `code_challenge` REQUIRED with no confidential-client
carve-out, while RFC 9700 is softer today ("Public clients MUST use PKCE... For confidential
clients, the use of PKCE is RECOMMENDED"). Third, algorithms: RS256 is the SHOULD default, and the
one hard refusal is that ID tokens MUST NOT use `alg: none` outside a narrow registered case, so the
verification should pin an accepted-algorithm allow-list rather than trusting the token header.
([OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1),
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html))

### OTLP: Current (Low)

**What we call.** A hand-written fetch-based exporter speaking OTLP/HTTP with the **JSON** encoding:
`observability-otel/src/index.ts:97-98` POSTs `{endpoint}/v1/traces` and `/v1/metrics`, `logs.ts:120`
`/v1/logs`, `platform.ts:101` `/v1/metrics`. Delta temporality, proto enum integers.

**Verdict.** The paths are still the specified defaults and JSON is a first-class encoding, not a
lesser one: "OTLP/HTTP uses Protobuf payloads encoded either in binary format or in JSON format",
same schema either way, traces/metrics/logs all Stable. Our two riskiest encoding choices are both
correct, and I checked our code rather than assuming: integer enums are not merely allowed but
mandatory ("only integer enum values are allowed in OTLP JSON Protobuf Encoding; the enum name
strings MUST NOT be used"), and IDs must be hex rather than base64, which `mapping.ts:210-216`
satisfies via `randomHex(16)` / `randomHex(8)`. 64-bit integers "are encoded as decimal strings, and
either numbers or strings are accepted when decoding", and `index.ts:169` already emits
`asInt: String(point.value)`, the stricter preferred form. Read 2026-08-18:
[OTLP](https://opentelemetry.io/docs/specs/otlp/),
[metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/).

**One real gap.** `partial_success` is load-bearing and we ignore it: servers populate rejection
counts, "the client MUST NOT retry the request when it receives a partial success response", and a
server MAY send warnings on a fully-accepted request with `rejected_<signal>` = 0 and a non-empty
`error_message`. Treating any 200 as full acceptance hides silently dropped spans, which is the
degrade-loudly rule again.

On delta temporality: the spec frames it as a trade-off rather than a recommendation, noting "Delta
temporality enables sampling and supports shifting the cost of cardinality outside of the process".
Our choice is consistent with the stated advantages but is not something we can cite as mandated.
Profiles is **not** adoptable: the path is `/v1development/profiles`.

### PagerDuty: Current (Medium)

**What we call.** `PagerDutyEnrichmentProvider.ts:52` adds a note to an existing incident
(`POST {base}/incidents/{id}/notes` with `{note: {content}}`), `:70` finds the active one
(`GET {base}/incidents?since=&statuses[]=triggered&statuses[]=acknowledged&sort_by=created_at:desc&limit=25`).
Auth `authorization: Token token=`, version pinned in the media type
`accept: application/vnd.pagerduty+json;version=2`, plus `from: this.opts.fromEmail`.

**Verdict.** All three of the things most likely to be wrong here are right. The media-type pin is
current: in the vendor OpenAPI (`PagerDuty/api-schema`, `info.version 2.0.0`) the `Accept` header is
`required: true` with default `application/vnd.pagerduty+json;version=2`, and no v3 REST surface or
version-2 sunset appears. `Token token=` is still the sole declared API-key scheme, described
verbatim as "The API Key with format `Token token=<API_KEY>`", with OAuth Bearer supported alongside
and no deprecation. And the classic PagerDuty trap does not bite us: `POST /incidents/{id}/notes`
does declare **`From` as a required header** ("The email address of a valid user associated with the
account making the request"), and `headers()` supplies it at
`PagerDutyEnrichmentProvider.ts:90`. `GET /incidents` needs no `From`. Read 2026-08-18:
[openapiv3.json](https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json).

`GET /incidents` uses offset pagination (`limit`, `offset`, `total`) with `statuses[]` repeated per
value across `triggered`, `acknowledged`, `resolved`, which is what we send; the response fields
`id` and `status` are correct.

### Slack: Current (Medium)

**What we call.** `SlackApiClient.ts:97` exchanges an OAuth code (`POST {base}/oauth.v2.access`),
`:157` dispatches every other method (`chat.postMessage`, `conversations.list`, `auth.test`) with
`authorization: Bearer`; `SlackConnectionService.ts:88` builds
`https://slack.com/oauth/v2/authorize`.

**Verdict.** All four methods are documented live with no deprecation notice, and none appears on
Slack's scheduled-changes page (which lists only `files.upload`, retired 2025-03-11, legacy Workflow
Builder steps, and classic-app items). The authorize URL is unchanged. The one retirement in flight
does **not** touch us: the classic-app and legacy-custom-bot retirement (2026-11-16, currently
paused) targets classic apps and legacy bots, explicitly not OAuth-v2 granular-scope apps, which is
what `oauth.v2.access` plus granular bot scopes makes us. Read 2026-08-18:
[conversations.list](https://docs.slack.dev/reference/methods/conversations.list),
[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage),
[oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access),
[future changes](https://api.slack.com/changelog/future),
[classic-app deprecation](https://docs.slack.dev/changelog/2024-09-legacy-custom-bots-classic-apps-deprecation/).

**Two operational facts.** `conversations.list` is **Tier 2** (20+/min) and `types` defaults to
`public_channel` alone, so private channels need `types=public_channel,private_channel` and shared
membership; `limit` defaults to 100, must be under 1000, with a recommendation of at most 200. The
2025/2026 non-Marketplace clampdown to 1 request/min applies to `conversations.history` and
`conversations.replies`, **not** to `conversations.list`. On 429 the docs say to evaluate
`Retry-After`, in recommendation rather than mandatory language.
`chat.postMessage` is Special-tier (about 1 message/second per channel), needs `chat:write`, and
requires `channel` plus at least one of `text`/`blocks`/`attachments`, with `text` still recommended
as the accessibility fallback. Scopes for the conversations read are unchanged
([rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)).
One item to check on our side: `oauth.v2.access` documents client credentials as strongly
recommended via HTTP Basic rather than body parameters, per RFC 6749.

### SendGrid and Resend: Current (Low)

**What we call.** `email/adapters.ts:23` posts `https://api.sendgrid.com/v3/mail/send`, `:52` posts
`https://api.resend.com/emails`, both with `authorization: Bearer`.

**SendGrid.** Endpoint, method and `Authorization: Bearer` all confirmed; required body fields are
`personalizations` (with `to`) and `from`; page last modified 2025-09-25 with no deprecation notice.
The one announced Mail Send change (recipients cut from 10,000 to 1,000 per request, effective
2025-07-09) applies to Web API **v2** and explicitly not v3, so we are unaffected. Two non-API facts
worth knowing: the free Email API plan was retired from 2025-05-27, and sendgrid.com now redirects to
twilio.com (February 2026), which will rot any doc link we hold. Sender Authentication is required
for new accounts, an account-setup precondition rather than a request field. An EU-regional
`https://api.eu.sendgrid.com` exists on some plan tiers. Read 2026-08-18:
[mail send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send),
[v2 changelog](https://www.twilio.com/en-us/changelog/updates-to-sendgrid-v2-api-mail-send-endpoint).

**Resend.** Exactly current: required fields `from`, `to`, `subject`, bare
`https://api.resend.com` base, and we are not missing a version prefix because there is none. The
FAQ says "Currently, there's no versioning system in place. We plan to add versioning via
calendar-based headers in the future", which is a thing to watch rather than a gap today. Read
2026-08-18:
[introduction](https://resend.com/docs/api-reference/introduction),
[send email](https://resend.com/docs/api-reference/emails/send-email).

### Brave Search and SearXNG: Current (Low)

**Brave.** `upstreams.ts:57` calls `https://api.search.brave.com/res/v1/web/search?q=&count=` with
`x-subscription-token`, reading `web.results[].{url,title,description}`. Path current; the auth
header is documented as `X-Subscription-Token` and HTTP headers are case-insensitive, so our
lowercase spelling is fine, and no `Api-Key` style appears. `count` is still the parameter, **max
20, default 20**, with `offset` capped at 9. `country` and `search_lang` are optional and
`Accept-Encoding` is not mentioned. Standard web results are **not** gated behind a higher tier, so
our reads carry no result-type risk, though plans are now metered (Search $5/1,000 requests, with $5
monthly free credits and a card required). Read 2026-08-18:
[get started](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started),
[query](https://api-dashboard.search.brave.com/app/documentation/web-search/query),
[responses](https://api-dashboard.search.brave.com/app/documentation/web-search/responses),
[pricing](https://brave.com/search/api/).

Brave documents rate-limit headers we honour none of: `X-RateLimit-Limit`, `-Policy`, `-Remaining`,
`-Reset`, each carrying **comma-separated per-window** values (so `1, 15000` means 1/second and
15,000/month), with 429 on exceed. A caller should parse both windows rather than the first number
([rate limiting](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting)).

**SearXNG.** `format=json` is still supported and, importantly, still **disabled by default**:
upstream `searx/settings.yml` ships `formats:` containing only `- html`, and requesting an unset
format returns **403**. So the operator-action premise our configuration depends on holds.
`results[].{url,title,content}` are confirmed as the real field names. Two things an operator can
turn on that would affect us: the limiter ships `limiter: false` but returns **429** when enabled,
and it applies stricter checks on `/search`, which is our path. Documented parameters we do not send:
`categories`, `pageno`, `safesearch`, `language`, `time_range`. Read 2026-08-18:
[settings.yml](https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml),
[search API](https://docs.searxng.org/dev/search_api.html),
[main result](https://docs.searxng.org/dev/result_types/main/mainresult.html),
[limiter](https://docs.searxng.org/_modules/searx/limiter.html).

### Zeplin: Current (Low)

**What we call.** `ZeplinProvider.ts:38` pins `https://api.zeplin.dev/v1`; `:98`/`:161` read a
project, `:109` its components, `:115` its design tokens, `:184` its screens with `limit=`, `:176` a
single screen.

**Verdict.** All five operations appear in the current reference under `/v1/`, the snake_case
`design_tokens` is the live path (`operationId: GetProjectDesignTokens`), and `limit` is documented
with **max 100, default 30** (alongside `offset`, `section_id` and `sort`). Docs are public and
ungated with no announced version change or sunset. Read 2026-08-18:
[getprojectscreens](https://docs.zeplin.dev/reference/getprojectscreens),
[getprojectdesigntokens](https://docs.zeplin.dev/reference/getprojectdesigntokens),
[introduction](https://docs.zeplin.dev/reference/introduction).

One caveat on the verdict's strength: the public changelog's last entries are from 2021, so
"actively documented" is verified while "actively evolving" is not.

### LLM provider base URLs: eight Current, three Drifting

`backend/packages/agents/src/providers/endpoints.ts` and
`backend/packages/kernel/src/domain/models.ts` type out the hosts an SDK is pointed at. The SDK owns
the wire shape, but the **host and the version suffix are ours**, and a mistake fails at dispatch
with no test catching it, which is why these are in scope at all. All read 2026-08-18.

**Current, verified unchanged:**

| Ours                                                       | Evidence                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://api.openai.com/v1`                                | `servers: url: https://api.openai.com/v1` in OpenAI's own published spec ([openapi.yaml](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml))          |
| `https://api.moonshot.ai/v1`                               | `.ai` is the host in every international example; `api.moonshot.cn` is not mentioned in the international docs ([kimi docs](https://platform.kimi.ai/docs/guide/agent-support)) |
| `https://api.x.ai/v1`                                      | `POST /v1/chat/completions` documented, no regional variants, no `/v1` deprecation ([x.ai](https://docs.x.ai/docs/api-reference))                                               |
| `https://openrouter.ai/api/v1`                             | `/api/v1/chat/completions` documented, no announced change ([overview](https://openrouter.ai/docs/api-reference/overview))                                                      |
| `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1` | quoted verbatim as the OpenAI-SDK `baseURL`; `client/v4` unchanged ([OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/))  |
| `https://api.z.ai/api/anthropic`                           | documented `ANTHROPIC_BASE_URL` value on two pages ([devpack](https://docs.z.ai/devpack/tool/claude), [scenario](https://docs.z.ai/scenario-example/develop-tools/claude))      |
| `https://api.moonshot.ai/anthropic`                        | documented `ANTHROPIC_BASE_URL` value ([kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi))                                                                            |
| `https://api.deepseek.com/anthropic`                       | documented as `export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` ([DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api))                                   |

All three Anthropic-compatible bases match our typed strings byte for byte as documented
`ANTHROPIC_BASE_URL` values. The caveat worth recording: **no vendor page shows the full request
path**, so the `/v1/messages` append rests on the Anthropic client's contract rather than on vendor
documentation.

**Drifting, none broken and none with a date:**

1. **DeepSeek `/v1`.** Two DeepSeek pages now document the base as the bare
   `https://api.deepseek.com` only; neither mentions `/v1`, and the newer Anthropic path hangs off
   the bare host. So our suffix is undocumented-but-historically-tolerated rather than the vendor's
   stated base. Its absence from the docs is not a removal notice, so this is drift to tidy rather
   than a break. ([api-docs](https://api-docs.deepseek.com/),
   [first API call](https://api-docs.deepseek.com/quick_start/first_api_call))
2. **DashScope `dashscope-intl.aliyuncs.com`.** Still valid, and labelled verbatim "Legacy shared
   domain. Still available; migration to a workspace-dedicated domain is recommended." No
   deprecation date. ([base URL](https://help.aliyun.com/en/model-studio/base-url))
3. **Cloudflare AI Gateway `workers-ai/v1`, the one worth acting on.** The generic provider-specific
   shape `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}` is current (confirmed
   verbatim for `openai`), but the **Workers AI** provider page no longer shows any
   `gateway.ai.cloudflare.com` URL at all: it documents the `api.cloudflare.com/client/v4/...` REST
   form plus a `cf-aig-gateway-id` header, and the gateway's OpenAI-compatible path is now
   documented as `/compat/chat/completions` with `workers-ai/<model>` in the **model field** rather
   than as a URL segment. Nothing read confirms our `workers-ai/v1` segment still resolves.
   ([workersai provider](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/),
   [openai provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
   [chat completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)).
   Incidental: `.../providers/workers-ai/` with a hyphen is a 404; the live slug is `workersai`.

## Opportunities

Each is tied to a consumer and the file that would change. Ordered by what they buy us.

**Removes an N+1 or a poll:**

- **Jira `POST /rest/api/3/issue/bulkfetch`** collapses the per-issue
  `GET /rest/api/3/issue/{key}` reads behind `JiraProvider.ts:116` into one call: up to 100 ids per
  call, or 1,000 when `fields` names at least one field. The no-N+1 rule in CLAUDE.md already asks
  for this against our own store; against a vendor it also costs rate limit.
- **Notion `GET /v1/pages/{page_id}/markdown`** returns a whole page as enhanced Markdown in one
  call, replacing the page-read-then-bounded-block-walk in `NotionProvider.ts:245-258` entirely, and
  it is explicitly aimed at "agentic systems and developer tools that work natively with markdown".
  It also gives us two things we currently cannot state: `truncated` and `unknown_block_ids` (up to
  100 ids, from permission gaps, unsupported block types, or the ~20,000-block cap), each
  re-fetchable by passing the id back. Today our bounded loop just stops.
  **Cost**: documented at `Notion-Version: 2026-03-11`, so it requires moving the pin.
  [reference](https://developers.notion.com/reference/retrieve-page-markdown)
- **Datadog `GET /api/v1/monitor` (ListMonitors)** replaces the per-id fan-out in
  `DatadogClient.ts:101` with one call, and takes the `group_states` we currently never send, which
  is the same parameter the state-change fix needs. `GET /api/v1/slo` plus `/api/v1/slo/search` cut
  the SLO metadata fan-out, though **no batch SLO-history endpoint exists**, so history stays
  per-id.
- **incident.io `status_category[one_of]` plus `filter_mode`** narrows `GET /v2/incidents`
  server-side, replacing the eight-page client-side walk in
  `IncidentIoEnrichmentProvider.ts:71-104`. The code comment there says the status filter keys on
  workspace-specific ids; the category operator is what it was looking for.
- **Figma `GET /v1/files/:key/nodes?ids=`** takes a comma-separated id list and would collapse
  per-node tree reads in `FigmaProvider.ts`; **Webhooks V2** at file and folder level would replace
  polling a file for changes (`GET /v2/webhooks` added, `GET /v2/teams/:id/webhooks` deprecated
  2025-05-28); and **GET file metadata** (`file_metadata:read`) is a cheap freshness probe instead of
  a full file fetch.
- **GitLab webhooks** would replace the `ci` gate's commit-status polling and merge-status polling
  through the existing `gateways.trackerWebhook`-shaped seam: MR hooks fire on `approval`,
  `approved`, `unapproval` and auto-merge, and Pipeline hooks carry `object_attributes.sha` plus
  `status`. **Linear webhooks** are an even closer fit: HMAC-SHA256 over the **raw body** in
  `Linear-Signature` plus a timestamp replay check, which is byte-for-byte the shape ADR 0032
  already specifies, and would replace the paginated overscan sweep as the primary intake path.
- **PagerDuty `/webhook_subscriptions`** would replace polling `GET /incidents` to find the open
  incident; `include[]` on `GET /incidents` folds related entities into the find call.
- **Slack `users.conversations`** returns only conversations the bot is a member of, which is usually
  the correct picker set, at Tier 3 (50+/min) rather than Tier 2. The **Events API** with Socket Mode
  would push `channel_created` / `channel_rename` / `channel_archive` instead of re-listing.
- **Kubernetes streaming lists** (`sendInitialEvents=true` with `resourceVersionMatch=NotOlderThan`,
  beta since 1.32 so available on every supported minor) replace the repeated full pod list.
  A metadata-only list via `Accept: application/json;as=PartialObjectMetadataList` is cheaper but
  strips the status we read, so it fits an inventory check rather than a status poll.
- **Resend `POST /emails/batch`** replaces N sequential sends with one request (up to 100 emails,
  50 recipients each). Caveat: `attachments` is not supported there yet.

**Removes a guess, or lets us degrade loudly:**

- **Retarget Langfuse at OTLP** using the exporter we already have. This is the forced migration
  rather than a tidy-up, and the point is that it is _cheaper_ than it looks: only the base URL, the
  Basic header and `x-langfuse-ingestion-version: 4` differ from what `observability-otel` already
  emits.
- **Read `partialSuccess` on OTLP 2xx responses** and do not retry when it is populated, replacing
  "any 200 is success" in `observability-otel/src/index.ts`. Silently dropped spans currently look
  identical to a clean flush.
- **GitLab `GET /projects/:id/merge_requests/:iid/reviewers`** returns per-reviewer `state`
  (`unreviewed`, `review_started`, `reviewed`, `requested_changes`, `approved`, `unapproved`), which
  is the review count `projection.logic.ts:219` currently renders as absent because GitLab "reports
  no counts at all". `GET .../approval_state` goes further and would let us state _why_ a merge is
  blocked rather than a bare count.
- **Jira `POST /rest/api/3/search/approximate-count`** recovers the `total` that `/search/jql`
  deliberately dropped, replacing any paginate-to-count loop.
- **GitHub `GET /repos/{o}/{r}/issues/{n}/parent`** resolves a child ticket's parent epic, which we
  currently cannot state because we only walk the hierarchy downward via `sub_issues`.
- **OpenRouter's dropped fields**, above all **`expiration_date`**, which would surface a model
  retiring _before_ a run fails on it, plus `supported_parameters`, the `architecture.*` modalities,
  and the cache/reasoning/request pricing dimensions that make our prompt-plus-completion cost model
  incomplete.
- **Notion `request_status`** (`complete` / `incomplete` with `incomplete_reason`) on search lets a
  partial result say so instead of reading as an empty-or-complete answer.
- **Linear's complexity headers** (`X-RateLimit-Complexity-Remaining`, `X-Complexity`) let us
  throttle before the 3,000,000-point/hour ceiling, which a large `first:` sweep reaches long before
  the request ceiling, and fix the 400-versus-429 mismatch.
- **Brave's rate-limit headers** and **Langfuse's `Retry-After`** replace blind retry and
  drop-the-batch respectively. **Notion's 529** should join 429 on the retry path.
- **Resend's `Idempotency-Key`** (unique per request, 256 chars, 24h expiry) guards a retry after a
  timeout from sending twice.

**Tightens a credential or a boundary:**

- **Figma plan access tokens** (GA 2026-07-23) are org-scoped and independent of an individual user,
  which is the direct answer to the new 90-day PAT ceiling.
- **MCP Client ID Metadata Documents**: hosting a `client_id` metadata JSON at an HTTPS URL gives us
  a registration path to a server we have no relationship with, which pre-registration alone does
  not. **Cost**: a deployment-visible URL to host, so it needs a website page.
- **PKCE on the Google flows** (`code_challenge_methods_supported` already advertises `S256`), and
  requiring `issuer` in OIDC discovery, and pinning an accepted-algorithm allow-list on ID-token
  verification.
- **Kubernetes projected ServiceAccount tokens** instead of a stored indefinite Secret token.
- **GitHub `search_type=semantic`** on `/search/issues` would catch duplicate and similar bugs that
  share no keywords, in bug intake and bug hunt. **Cost**: 10 requests/minute, which suits bug
  hunt's once-per-scan rule (a hard requirement per `bug-hunt.md`) but rules out per-ticket fan-out.

**Moves a base URL to the vendor's current form:**

- **Alibaba workspace-dedicated domains**:
  `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`, documented as offering
  higher throughput, lower latency and workspace-level traffic isolation, with `cn-beijing` and
  `ap-southeast-1` variants. A genuine regional and per-tenant endpoint, so it belongs in config
  rather than as the hard-coded host `endpoints.ts:9` pins today.
- **Cloudflare AI Gateway `/compat`**:
  `gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions` with
  `workers-ai/<model>` as the model string is the currently documented multi-provider
  OpenAI-compatible path, and would replace the provider-segment form at `endpoints.ts:168`.

**Deliberately passed over**, so a later sweep does not re-propose them:

- **Jira dynamic webhooks** (`POST /rest/api/3/webhook`): the spec states "Only Connect and OAuth 2.0
  apps can use this operation", so they are unreachable for our Basic-auth integration without moving
  to OAuth 2.0 (3LO). The token-friendly alternative is an admin-configured UI webhook, which is an
  operator step rather than something we can provision.
- **Datadog `GET /api/v2/slo/{slo_id}/status`**: cheaper, but `x-unstable`. Do not adopt while
  preview.
- **OTLP `/v1development/profiles`**: not stable, not adoptable.
- **Gemini grounding tools, streaming, `background` execution, stored multi-turn**: still correctly
  excluded from the hand-written contract. Grounding is the one that bills, and a step asked to draw
  an image has no business searching the web.
- **SendGrid EU endpoint**: only if EU data residency is ever required, and it is plan-tier gated.

## Unverified

Listed separately because an unchecked call and a checked-and-correct call are different facts. Every
one of the 34 vendors was swept; these are the questions the vendors' own documentation could not
settle.

- **Whether `.../workers-ai/v1` after the AI Gateway prefix still resolves.** Four Cloudflare pages
  read; none confirms or denies it, and the Workers AI provider page has dropped the gateway URL
  form entirely. A Cloudflare changelog entry announcing the slug removal, or one live request, would
  settle it. This is the reason that row is Drifting rather than Current or Broken.
- **The `/v1/messages` append for the three Anthropic-compatible bases.** No vendor page shows a
  full URL or curl example, so that half of the path rests on the client's contract. A vendor curl
  sample would settle it.
- **Whether DeepSeek still accepts `/v1`.** Its absence from the current docs is not a removal
  notice. Only a vendor statement or a live call settles it.
- **`api.openai.com/v1/models` and `api.x.ai/v1/models`.** OpenAI's human-facing reference returned
  HTTP 403 to the fetcher (the published spec was read instead, and `/models` fell outside the
  excerpt returned); xAI's page did not document `/models`. Both `/chat/completions` paths, which are
  the ones that matter, were confirmed.
- **Whether `GET /wiki/rest/api/content/{id}` returns 404 or 410 today.** The evidence is documentary
  (retirement date passed, endpoint absent from the reference), not a live call. One authenticated
  request against a real site is the check to run before choosing between "already broken" and "about
  to break", and it does not change the migration.
- **What replaces incident.io's incident-update POST.** No public endpoint for privately annotating
  an incident was found. A full path dump of incident.io's complete OpenAPI spec, or a vendor support
  answer, would settle it. This is a design question, not a lookup.
- **The Gemini declined-generation shape** (our 200-with-text-and-no-image claim). Nothing read
  documents the Interactions API's refusal response, and `api-errors` frames blocked generations as
  error codes, which contradicts us. The response schema on the interactions reference, or one live
  declined call, would settle it. Highest-value remaining gap, because it drives the instruction the
  agent follows.
- **Whether `/v1/interactions` request bodies are byte-identical to `/v1beta`**, which decides
  whether the GA move is a one-word change.
- **Which host serves Figma `/v1/images` signed URLs.** Undocumented by Figma: two pages describe the
  response as an opaque id-to-URL map and the 30-day expiry, and neither names a host, bucket or CDN
  domain. So our `figma.logic.ts:41` allow-list rests on observed behaviour, not a vendor contract,
  and Figma can move it with no doc change and no deprecation. A live call against a real file key,
  or a Figma support answer, would settle it.
- **Zeplin's exact PAT header.** Personal access tokens exist and an OAuth2 security scheme is
  published, but no page printed a literal `Authorization: Bearer` example.
- **Linear's documented maximum page size**, which is published nowhere; and whether
  `Authorization: Bearer <personal key>` is _also_ accepted; and whether `[INTERNAL]` implies a
  stability or access guarantee, which the deprecations page does not define.
- **npm's `%2f` encoding, abbreviated-metadata form, rate limits and user-agent policy** (see that
  section).
- **Datadog's deprecations page and API changelog**, which would settle whether a deprecation is
  announced but not yet in the spec; the rate-limit quotas and whether `X-RateLimit-Reset` or
  `Retry-After` are sent; and the scoped-app-key scope name for logs aggregate, which is absent from
  the spec's OAuth scope list. The rendered pages are JS-built and returned no fields to a fetcher.
- **Whether a newer MCP revision or draft exists beyond `2026-07-28`.** `/specification/latest`
  resolved to it today, but no revisions index or draft page was read.
- **Whether Slack formally mandates `Retry-After`** (the docs recommend rather than require), and a
  complete Slack changelog sweep: the changelog rendered one entry to a fetcher, so the "no
  deprecation" conclusion rests on the four method pages plus the scheduled-changes page.
- **Brave's formal response schema** (field optionality/nullability is shown only by example), and
  whether `Accept-Encoding` matters.
- **Confluence `GET /wiki/rest/api/content/search`'s long-term status.** Still documented and not in
  RFC-19's list, but with no v2 successor its future is unstated.

## Follow-ups

The sweep records; it does not refactor. **Every follow-up below is now addressed**, in one PR
rather than fourteen, with the `Status` column saying what each one turned into. Three of them
resolved to a decision NOT to make the change, each for a reason the sweep itself could not have
had, and those are the rows worth reading: a sweep that only records what it changed leaves the
next one free to re-propose what was already weighed and refused.

| #   | Fix                                                                                                                                                                                                           | Verdict driving it                | Status                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| 1   | Move Confluence page reads to `GET /wiki/api/v2/pages/{id}` (body and version), keep CQL search on v1                                                                                                         | Broken, High                      | Landed                                                          |
| 2   | Design and land incident.io enrichment against an endpoint that exists, and replace the bare `catch {}` at `gates.ts:347` with `runBestEffort` so the next such break is visible                              | Broken, Medium                    | Landed, as `POST /v2/actions`                                   |
| 3   | Bring the MCP probe to revision `2026-07-28` (per-request `_meta`, `Mcp-Method`/`Mcp-Name`, `server/discover`), with a dual-era fallback                                                                      | Broken, High                      | Landed, dual-era                                                |
| 4   | Retarget Langfuse at its OTLP endpoint using the existing exporter, before 2026-11-16                                                                                                                         | Deprecated with a date            | Landed                                                          |
| 5   | Repoint Google userinfo at `openidconnect.googleapis.com/v1/userinfo`, ideally reading all three URLs from the cached discovery document                                                                      | Drifting, High                    | Landed (path only, not via discovery)                           |
| 6   | Correct the Gemini contract: narrow `thinking_level` to `minimal`/`high`, fix the reference-image split per model, add the 401 `UNAUTHENTICATED` response, publish lite's `$30`/1M rate, and move to GA `/v1` | Drifting, Medium                  | Landed, except the GA path move                                 |
| 7   | Fix the Datadog monitor state-change read (`group_states=all` plus `state.groups[*].last_triggered_ts`), or stop reporting a time we cannot get                                                               | Drifting, Medium                  | Landed                                                          |
| 8   | Move Figma refresh to `/v1/oauth/token`; plan for the 90-day PAT ceiling                                                                                                                                      | Drifting, Medium                  | Landed, plus a website warning                                  |
| 9   | Fix the MCP authorization-server probe list (add the OIDC path-insert location, drop the undocumented one, add the `issuer`-equality check)                                                                   | Drifting, Medium                  | Landed; equality binds a DECLARED issuer only                   |
| 10  | Treat Linear rate limiting as 400 `RATELIMITED`, and hedge `sort` with documented `orderBy`                                                                                                                   | Drifting, Medium                  | Half landed: a `rate_limited` setup verdict, no `orderBy` hedge |
| 11  | Read OTLP `partialSuccess` instead of treating 200 as full acceptance                                                                                                                                         | Current, but a degrade-loudly gap | Landed                                                          |
| 12  | Classify GitLab 413/429 on commits and files reads; fix the `/auth/pat` doc hint; treat `detailed_merge_status` as an open vocabulary                                                                         | Current, with drift               | Landed                                                          |
| 13  | Settle the Cloudflare AI Gateway Workers AI path, moving to the documented `/compat/chat/completions` plus a model-prefixed id if the `workers-ai/v1` segment is gone                                         | Drifting, Medium                  | Refused: evidence recorded instead                              |
| 14  | Drop the undocumented `/v1` from the DeepSeek base; expose DashScope's workspace-dedicated domain as config rather than pinning the legacy shared host                                                        | Drifting, Low                     | Landed (DashScope: the override IS the config)                  |

**Two rows say more than "landed", and the reason is the same in both.** Implementing a recorded
fix is where its edges show up, and an edge the record did not have is worth writing down here
rather than only in the code.

- **9, the `issuer` equality.** RFC 8414 §3.3 compares a metadata document against the issuer
  identifier the client was GIVEN. When a server publishes no protected-resource metadata the walk
  falls back to the resource's own ORIGIN, which is a guess this side made rather than an identifier
  anyone published, so the equality would test the guess and refuse every deployment whose
  authorization server legitimately identifies as something else (a fronted IdP, a tenant path). It
  binds a declared issuer, and the origin fallback keeps the requirement that the document carry an
  `issuer` claim at all.
- **10, the Linear rate limit.** Reading the error `code` is only half a fix while every caller
  still sees an `error`. A setup check now answers `rate_limited`, an eighth verdict in the task
  source diagnostic vocabulary, because "the key is valid and the quota is spent" and "the key is
  rejected" need different actions from whoever is looking. GitHub's secondary limit arrives as a
  403 and has the same problem, which is why the verdict is worded for any source.

**The three that were refused, and why.** Each was re-checked against the vendor's live docs while
being implemented, and each turned out to be a change the sweep would not have proposed had it read
the page the implementation had to read.

- **6, the `/v1beta` to `/v1` move.** Google's version page does say the Interactions API is
  generally available in `v1`, but its image-generation page's own curl example still posts to
  `/v1beta/interactions`, and no page shows an image request against `/v1`. An agent composes its
  request from our hand-written contract alone, so transcribing a path the vendor's own worked
  example contradicts would trade a working call for a tidier one.
- **10, hedging `sort` with `orderBy`.** `sort` is annotated `[INTERNAL]` and that is a real
  dependency, but it carries no deprecation and it is the only argument that states a DIRECTION:
  Linear documents no direction for `orderBy` at all. Swapping would trade a stated ascending order
  for an unstated one on the query whose whole correctness is the order.
- **13, the Cloudflare AI Gateway path.** Settled as far as evidence goes: nothing Cloudflare
  currently publishes shows a `workers-ai/v1` segment, and the gateway's OpenAI-compatible route is
  documented as `/compat/chat/completions` with `workers-ai/<model>` in the MODEL field. That makes
  the migration a two-part change (base URL AND model string) touching the inline resolver and the
  proxy's forward path, which passes the container's body through untouched, and neither half can be
  verified from here without a live gateway. The evidence is recorded at the call site instead of
  the change being made half-way.

One note on what did NOT come here. Any fix under `backend/internal/executor-harness/src/` (the
GitHub pin lives there at `vcs-api.ts:266,460,495`) bumps the runner image and the pinned tag
everywhere it appears, which makes it a separate and heavier PR by construction. Nothing in this
round touched it.

Two website PRs went first under ADR 0051, for the two facts an operator can act on and nothing in
the deployment would tell them: Figma's 90-day personal-access-token ceiling, and the self-hosted
Langfuse version (v3.22.0) that serves the OpenTelemetry endpoint traces now go to.
