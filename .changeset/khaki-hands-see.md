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
Six of them dropped a tier they were holding: the in-app assistant had the asker's id and passed
only the workspace, the monorepo adoption advisor held a required run id it already used for
telemetry, and the fragment selector's own port carried no run fields at all. Nothing failed. The
call resolved, answered, and landed on the deployment's routing default instead of the model the
workspace's preset names, so on a Claude-preset workspace the assistant quietly ran on something
else and only the bill said so.

Every inline caller now goes through kernel's `resolveInlineScope`, whose subject is discriminated
(`block` / `run` / `user` / `workspace`), so a caller states what it holds rather than omitting it.
`kind: 'workspace'` stays legal and is now a claim: several callers legitimately make it, and two
that had reasoned omissions (the Kaizen grader, the fragment-brief generator) keep them and say so.
`scripts/check-inline-model-scope.mjs` keeps it that way.

Run-less surfaces can now reach a personal subscription. A credential activation was keyed by run,
so the assistant and the bug hunt could not lease one at all; the key was never really a run id
(an environment test already wrote its own into it), so it is now an `ActivationScopeId` that a run
or a USER mints. The assistant and the bug hunt carry the personal password header like a run start
does, and the SPA's existing credential modal collects it on the first turn that needs one.

BREAKING (internal): `subscription_activations.execution_id` becomes `scope_id` and existing rows
are dropped, on both runtimes. Scope ids are now prefixed by kind, so an old unprefixed row would
never be looked up again, and nothing records which kind it was. An activation is a 12-hour cache
of a credential the user can re-unlock with their password, so the cost is one password prompt.
`SubscriptionActivationRepository.deleteByExecution` becomes `deleteByScope`, and
`PersonalSubscriptionService.activateForRun` / `leaseForRun` become `activate` / `lease`.
