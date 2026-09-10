---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/consensus': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
---

Run every inline LLM call on the model the workspace actually picked

An inline call resolves its credentials from a `ModelScope`, and each caller built one by hand.
Several of them dropped a tier they were holding: the in-app assistant had the asker's id and
passed only the workspace, and so did the bug hunt, the document planner and the sandbox launch,
each of them a signed-in member's own synchronous request. Nothing failed. The call resolved,
answered, and landed on the deployment's routing default instead of the model the workspace's
preset names, so on a Claude-preset workspace the assistant quietly ran on something else and only
the bill said so.

Every inline caller now goes through kernel's `resolveInlineScope`, whose subject is discriminated
(`block` / `run` / `user` / `workspace`), so a caller states what it holds rather than omitting it.
`kind: 'workspace'` stays legal and is now a claim: several callers legitimately make it, and the
ones with reasoned omissions say why (the Kaizen grader and the fragment-brief generator keep
theirs; the monorepo adoption advisor's `runId` is a bootstrap job id, which is a telemetry key
rather than an activation scope). `agentRunScopeSubject` is the shared dispatch fold, so a
consensus participant and the same step run alone cannot disagree about whose pool they draw on,
and `scripts/check-inline-model-scope.mjs` keeps the whole thing that way.

Run-less surfaces can now reach a personal subscription. A credential activation was keyed by run,
so the assistant and the bug hunt could not lease one at all; the key was never really a run id
(an environment test already wrote its own into it), so it is now an `ActivationScopeId` that a run
or a USER mints. The assistant and the bug hunt carry the personal password header like a run start
does, and the SPA's existing credential modal collects it on the first turn that needs one. Both
surfaces re-map or swallow model failures by design, so each now rethrows `credential_required`
first, or the refusal never reaches the modal. Removing a subscription drops its user-scope
activations, which the soft delete alone left leasable for the rest of the TTL.

BREAKING (internal): `subscription_activations.execution_id` becomes `scope_id` and existing rows
are dropped, on all three stores (D1, Postgres, and the local-sqlite credential store, which
declares the table rebuildable so the rename reaches a file that predates it). Scope ids are now
prefixed by kind, so an old unprefixed row would never be looked up again, and nothing records
which kind it was. An activation is a 12-hour cache of a credential the user can re-unlock with
their password, so the cost is one password prompt.
`SubscriptionActivationRepository.deleteByExecution` becomes `deleteByScope`, and
`PersonalSubscriptionService.activateForRun` / `leaseForRun` become `activate` / `lease`.
