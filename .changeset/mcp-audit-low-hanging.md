---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/mcp-server': patch
---

Findings of the 2026-08-09 MCP audit, the low-hanging half (the rest lands in the
`mcp-maturation.md` tracker as slice 9 and its new inventory rows).

A tool-server credential rides the ONE channel its transport has: a `stdio` server is a child
process with an environment and no request, an `http` server is a remote url with headers and no
process. Naming the other one resolved the value and folded it into nothing, leaving the server
wired, advertised in the prompt, and started unauthenticated. Both directions are now refused, at
all three layers a definition can reach: boot validation (`unusable_credential_header` for a header
on `stdio`, `missing_credential_header` for an `http` credential with none, both errors), the
dispatch, and the Test-button probe. The two runtime refusals exist because a mothership-mode node
boot-validates nothing it resolves.

FLAGGED BREAK: a deployment carrying either (previously silently broken) declaration now fails boot
naming the server, the key and the fix. Remove the `header` on a `stdio` credential; add one to an
`http` credential.

PUBLIC API, additive (OpenAPI `1.37.0`): the unavailable-tool-server `reason` vocabulary gains
`unusable_secret`, which the run reads project. It is kept apart from `missing_secret` (the value
resolved) and `reserved_secret` (nothing was withheld), because only its own member points at the
declaration. The probe's status vocabulary gains the app-only `credential_unusable` beside it.

The rest is doc truth: the `@cat-factory/mcp-server` README's mounting example imports from
`./http` (the root drags the stdio boot into a Worker bundle) and its group table lists all sixteen
groups; three docs stop claiming two omitted operations where the omission list has three; the
hosted endpoint's JSON-RPC batch acceptance is stated as transport compatibility rather than a
protocol promise (the 2025-06-18 revision removed batching); `security-model.md` gains the
serving-side subsection; and the `MCP_OAUTH_CALLBACK_PATH` docstring stops claiming consumers that
did not exist.
