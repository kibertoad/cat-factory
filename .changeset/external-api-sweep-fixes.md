---
'@cat-factory/agents': minor
'@cat-factory/app': minor
'@cat-factory/binary-generators': minor
'@cat-factory/contracts': minor
'@cat-factory/gates': minor
'@cat-factory/gitlab': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/observability-langfuse': minor
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Act on the first external-API sweep: three vendor surfaces had already moved, two more carry
announced dates, and eight had drifted.

**Broken.** Confluence page reads move to Cloud REST v2 (`GET /wiki/api/v2/pages/{id}`); the v1
content endpoint they targeted was retired on 2025-04-30, and CQL search stays on v1 because v2
publishes no search endpoint. incident.io enrichment posts to `POST /v2/actions`, an endpoint that
exists, where `POST /v2/incident_updates` never has at any version: the investigation lands as an
unassigned action on the live incident rather than a status-page update (which would re-alert
customers) or a follow-up (which is post-incident work). The MCP tool-server probe is now dual-era:
revision `2026-07-28` deleted the `initialize` handshake, `notifications/initialized` and
protocol-level sessions, so the probe opens in the modern stateless dialect and falls back to the
handshake on a refusal that is not one of the three MCP-reserved error codes, or on any refusal
naming a handshake-era revision. `server/discover`'s `supportedVersions` is negotiated onto rather
than read and discarded, and the HTTP status is read before the body, so a 401 answered in JSON
(the ordinary shape for an OAuth-protected server) is one refusal rather than two.

**Dated.** The Langfuse sink is now the OTLP exporter pointed at Langfuse's OpenTelemetry endpoint;
the batch ingestion API it used to speak is deprecated, sunsets on Langfuse Cloud on 2026-11-16, and
its three event types are already unsupported on the v4 data model.

**Drift.** Google userinfo reads from `openidconnect.googleapis.com/v1/userinfo`, the host Google's
own discovery document publishes. Datadog monitor reads ask for `group_states=all` and fold
`state.groups[*].last_triggered_ts` over the groups that are STILL ALERTING, so the
post-release-health gate can once again tell a standing alert from one this release caused; the
field it used to read is not in Datadog's schema, so the transition time was silently always
absent, and the per-group timestamp outlives the group recovering, so folding it over every group
would hand a week-old standing alert to whatever release a since-cleared blip landed after. Figma OAuth refreshes at `/v1/oauth/token`, which
superseded `/v1/oauth/refresh`. The MCP authorization-server discovery walk drops an undocumented
location, adds the OpenID Connect path-insert one, and enforces RFC 8414's issuer-equality check
against a DECLARED issuer: in the origin fallback there is no published identifier to compare
against, so the equality would refuse every deployment whose authorization server identifies as a
fronted IdP or a tenant path. Linear rate limits are read off the error `code`, because Linear
answers an exhausted quota with HTTP 400, and a setup check reports one as the new `rate_limited`
verdict: the key is valid and the fix is to wait, which neither `auth_failed` nor a generic error
says. The OTLP exporter reads `partialSuccess` instead of treating any 200 as full acceptance.
GitLab 413s carry their own remedy. The Gemini image contract narrows `thinking_level` to the two
values that exist, states the per-model reference-image split, and declares the 401 an invalid key
really returns. The DeepSeek base URL drops an undocumented `/v1`.

**Additive on the wire:** a task source's setup check can answer `rate_limited`, an eighth verdict
in `taskSourceDiagnosticStatusSchema`.

**Breaking for an embedder:** kernel's `GateContext` and `JudgeContext` now carry a required
`logger`. Both are built by the engine (`makeGateContext`) and by `stubGateContext` /
`stubJudgeContext` in tests, so a registered gate or judge needs no change.
