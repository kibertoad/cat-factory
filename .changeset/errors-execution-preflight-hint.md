---
'@cat-factory/orchestration': patch
---

Give every execution failure kind an actionable board hint (error-message initiative G3).

The execution engine's `EXECUTION_FAILURE_HINTS` map omitted `preflight`, yet the engine
produces that kind whenever a precondition rejects a run before dispatch — most commonly a
`github_not_connected` `ConflictError` raised while building the job for a workspace with no
connected repository (`classifyDispatchFailure` → `preflight`). Those failures reached
`AgentFailureCard` on the board with `hint: null`, so the card showed the terse message with
no "what to do next" guidance.

`preflight` now carries a hint (connect GitHub and link a repository, or pick a configured
model in the workspace settings, then retry), and the map is retyped from
`Partial<Record<AgentFailureKind, string>>` to an exhaustive `Record<AgentFailureKind,
string>` — the engine is the primary producer of the full union, so a total map is correct
and its type is now the drift guard: adding a new failure kind without a hint is a typecheck
failure. The two other hint maps were already safe (bootstrap is exhaustive over its narrow
alias; env-config-repair keeps a `?? unknown` fallback over the subset it produces) and are
unchanged.
