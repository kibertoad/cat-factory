---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/consensus': patch
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Let a workspace rewrite any agent's system prompt from the pipeline builder, and switch back
through every version it has run.

The store is an append-only revision log per `(workspace, agent kind)` — the highest revision is
live — so restoring an older prompt appends a copy of it rather than overwriting, and "back to the
built-in" is itself a recorded revision (a null text) that keeps the workspace tracking the shipped
prompt as it improves instead of pinning a stale copy. The composite key doubles as the concurrency
control: a second editor's save collides and is refused as `prompt_revision_conflict` rather than
silently winning last-write.

An override replaces the shipped TRACK prompt only. `systemPromptFor` gained an optional `override`
argument and still layers the engine-enforced surface directives and trait guidance on top, so a
workspace cannot edit away the read-only guardrail or the answer-in-your-reply rule. The engine
resolves the live revision once per dispatch onto `AgentRunContext.systemPromptOverride`; container
dispatch rides the new `dispatchSystemPromptFor` seam, which also covers the two kinds (`merger`,
`on-call`) whose dispatch bypasses `systemPromptFor` — so the editor's "built-in" baseline is the
text those kinds actually run.

New: the `agent_prompt_revisions` table (D1 migration 0068 ⇄ Drizzle), the `AgentPromptRepository`
kernel port (remote-bucket for mothership mode), `GET|PUT /workspaces/:ws/agent-prompts[/:agentKind]`
gated on `settings.manage`, and the `prompt_revision_conflict` conflict reason.
