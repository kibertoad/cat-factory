---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/consensus': patch
'@cat-factory/sandbox': minor
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
workspace cannot edit away the read-only guardrail or the answer-in-your-reply rule. Holding that
takes two mechanisms, because an invariant reaches a shipped prompt by two routes and only one of
them survives having the track prompt replaced: `restoreShippedInvariants` puts back a rule a
built-in track prompt carried INLINE (without it, editing any kind whose deliverable is its reply —
spec-writer, the testers, the reviewers — silently drops the answer-in-your-reply rule and the run
fails on an empty visible reply), and `BESPOKE_CONTAINER_SYSTEM_PROMPTS` declares `merger` /
`on-call` as a `{ role, directives }` pair since those two bypass `systemPromptFor` entirely. The
editor SHOWS the resulting appended text (`AgentPromptDetail.appendedText`, measured from the real
composition) rather than describing it, so the promise is checkable rather than taken on trust.

The engine resolves the live revision once per dispatch onto
`AgentRunContext.systemPromptOverride` and pins it to `PipelineStep.promptRevision`, which Kaizen
folds into its `(prompt, agent, model)` combo key — an edited prompt is its own combo rather than
inheriting a verification the shipped one earned.

New: the `agent_prompt_revisions` table (D1 migration 0068 ⇄ Drizzle), the `AgentPromptRepository`
kernel port (remote-bucket for mothership mode), `GET|PUT /workspaces/:ws/agent-prompts[/:agentKind]`
gated on `settings.manage`, and the `prompt_revision_conflict` conflict reason.

The Sandbox is the other half of this feature and is now wired to it in both directions. A
workspace's own prompts are projected into the prompt browser as read-only `workspace` versions
(synthesized per request from the revision log, with the live one marked), so an experiment can
measure a candidate against the prompt that is actually running rather than only against what the
product ships — previously the only control on offer, and silently the wrong one on any workspace
that had edited a kind. And a version can be PROMOTED to the live prompt:
`POST /agent-prompts/:kind/promote`, deliberately on the prompt controller so it answers to
`settings.manage` rather than the sandbox's `integrations.manage`.

Behaviour change worth knowing: a stored sandbox `systemText` is now the BASE (track) prompt, and
`SandboxRunService` composes the platform's directives on top at run time through the same
`systemPromptFor` override path production uses. Previously it sent the stored text raw, so it
graded a prompt that is never what gets sent — tolerable while the sandbox was a closed loop, and
not tolerable once a graded candidate can become the live prompt. Existing candidates keep their
text; their grades shift, because they are now measured on the composed prompt.
