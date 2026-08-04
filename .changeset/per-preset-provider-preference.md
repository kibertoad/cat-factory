---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/consensus': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Let a model preset choose the ORDER a model's routes are preferred in, instead of one order compiled into the resolver.

Which route a model takes was a deployment-wide constant, so a workspace could not have both a compliance preset pinned to a residency-guaranteed route (AWS Bedrock, whose selectability landed in the previous slice) and an everyday preset riding a flat-rate subscription. It is a per-WORKLOAD choice, so the knob is the preset row (`ModelPreset.providerPreference`) rather than a new env var, and it needs no migration of behaviour: a preset stating nothing resolves exactly as before.

**A preference REORDERS, it never filters.** Routes a preset omits are appended in default order and tried last, so naming three routes cannot make a model whose only route is the fourth unresolvable. That is structural rather than a rule to remember: `orderedModelFlavorPreference` returns a total order over every route, which is also why the editor offers no way to REMOVE one. The write boundary refuses a repeated route (an order cannot say two things about one route) but accepts a partial list.

**The order rides `ProviderCapabilities`, and it reaches a run by two paths because a capability set is resolved at two different times.** The START GUARD resolves one per run, so it now resolves under the block's own preset and walks each model's routes in the order the dispatch will. A DISPATCH has no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one — so the order arrives on `AgentRunContext.providerPreference`, resolved ONCE by the engine exactly like the prompt override and the output budget, and the facade folds it onto its captured capabilities per call. Folding rather than replacing is the point: which routes EXIST is a deployment fact (keys, the Bedrock allow-list, the Workers AI binding) and only the ORDER is per preset. Both ends read one preset row, so the guard, the container path, the inline path and the consensus panel cannot disagree about which provider a step ran on.

**Seven inline callers each carried a byte-identical copy of the step precedence**, which is how a fact like this gets forgotten in six places. The judge, the fork-decision chat, the iterative reviewers (with their brainstorm and clarity subclasses), the doc and initiative interviewers, the tester QC companion and the bug-hunt assessor now share one `resolveInlineBlockModelRef`, wired through one factory that hands out the model resolver and the route order TOGETHER: a site that wired the first and forgot the second would resolve a preset's model onto the deployment's default route, and nothing would fail.

**"Equals the default order" is stored as ABSENT, not as a copy of it.** Reordering back to the default clears the preference, so a preset keeps tracking the shipped order as the product changes it instead of pinning today's wording of it — which matters because that order is itself scheduled to change. For the same reason the default order now lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in contracts: the preset editor renders the same fold the resolver walks, and a copy in the SPA would let the picker display an order the run does not take.

Compatibility break to expect: none for existing rows (`provider_preference` is nullable and NULL means the default order), but a stored route the build no longer knows is DROPPED at the read boundary rather than named. That is the opposite disposition from a retired binary modality, and deliberate: the value names a route, so once the route is gone there is no current member a human could re-pick it as, and the surviving entries keep their relative order.
