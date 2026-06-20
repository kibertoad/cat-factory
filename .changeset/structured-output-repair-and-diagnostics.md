---
'@cat-factory/executor-harness': patch
---

Add a reusable structured-output abstraction with a repair retry + diagnostics for the
JSON-returning container agents (requirements, blueprint, merger), so a single
malformed reply no longer fails the whole run.

A caller describes its output once as a `StructuredOutputSpec<T>` (label, shape hint,
parser) and calls `resolveStructuredOutput`. It parses the agent's primary reply and,
on failure, makes ONE structured "repair" call — a single-shot, no-tools,
NON-streaming completion through the same proxy with `response_format: json_object`,
asking the model to return only the corrected JSON — then reparses. It is
provider-agnostic (external OpenAI-compatible upstreams honour `response_format`; the
in-process Workers AI path ignores it but answers buffered and the focused prompt keeps
it to JSON) and capability-gated by construction (an upstream that can't enforce
`response_format` falls back to the prompt).

Observability: every parse failure and repair outcome is logged (warn on first
failure, info on recovery, error when the retry doesn't help), the repair call lands in
`llm_call_metrics` as a NON-streaming row for the agent kind (so repair attempts are
queryable), and a compact diagnostics suffix — including a token-doubling detector
(`looksTokenDoubled`) that flags the streaming-corruption signature — is folded into
the persisted failure reason. Changes the image, so the harness version (its registry
image tag) bumps.
