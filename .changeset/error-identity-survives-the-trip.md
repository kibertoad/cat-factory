---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
---

Make a failure's machine-readable cause survive the trip to the client, on both runtimes.

Three defects shared one root: a cause code existed at the point of failure and was dropped before
anything could act on it.

**The Cloudflare driver recorded `AgentFailure.reason: null` on every path.** Its local `failRun`
helper simply had no `reason` parameter while the runtime-neutral `driveExecution` twin forwarded
one — so the SPA's `AgentFailureCard` remedies (the "Connect GitHub" jump, the deploy-runner hint)
were dead on the deployed runtime and worked on Node. Fixed by removing the ability to diverge
rather than by adding the parameter: both drivers now fail through one shared `RunFailure` value
built by `failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`, so a dropped field
is a typecheck failure. Both also now lift a mid-advance `DomainError`'s reason, which neither did.

**~120 hand-rolled error envelopes could not carry `details.reason` at all.** `unavailable` (503),
`unauthorized` (401) and `rate_limited` (429) existed only as `c.json({ error: { code } }, status)`
literals, so the machine-readable code the SPA maps to translated copy had nowhere to live — and
around 20 further envelopes had smuggled the reason into the `code` slot instead. Kernel gains
`UnauthorizedError` / `UnavailableError` / `RateLimitedError`, and every controller now REFUSES by
throwing, leaving `handleError` the single producer of the wire envelope. Two shared total
accessors (`requireCapability`, `requireUser`) replace the per-controller nullable-read-plus-guard
pair, which removed the `if (!x) return unavailable(c)` line from every route it guarded.

**The inline LLM path ignored the workspace privacy opt-out.** The proxied path gated prompt and
response BODIES on `LLM_RECORD_PROMPTS` _and_ the per-workspace `storeAgentContext`; the inline
feeder honoured only the deployment switch, so a workspace that had explicitly opted out still
shipped its judge / consensus / requirements-writer prompts and replies to Langfuse and OTel. Both
paths now share one `createStoreAgentContextGate`, required (not optional) on the inline provider.

Behaviour changes worth knowing: `LlmProxyController` no longer echoes an upstream exception's text
onto the wire (it can carry the request URL or an auth header — it stays in the log and on the call
metric), the two proxy controllers' previously code-less envelopes now carry one, and a test that
drives a controller through a bare Hono app must mount `app.onError(handleError)` or every refusal
reads as a 500.
