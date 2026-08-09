---
'@cat-factory/gatekeeper-worker': minor
---

Push approval cards and run events to a Cloudflare OS workspace through the contract's hook
lifecycle, verify a share instead of refusing it, and check a call's arguments against what the
operation declares.

Sessions gain `approvals_subscribe(callback)`, `runs_subscribe(callback)` and `hooks_bound()`. A
bind hands the workspace a `CatFactoryHookController` (a fifth named export the deployment's entry
module must carry) and stores nothing until the workspace enables it; each delivery then asks for a
fresh callback and is authorized as an observation before it is pushed. A hook is an accelerator
over `approvals_list()` and `runs_watched()`, which stay the truth: the live half of a registration
is a stub and cannot be stored, so a push that finds none counts a `missed` on the record rather
than passing over it, and `hooks_bound()` publishes that beside `live`.

A registration is identified by WHERE its deliveries land rather than by the id one bind minted, so
re-binding after an eviction (the documented remedy for a hook gone quiet) re-arms the same hook
and carries its counters over instead of leaving a dead row behind for good. The fan-out runs
behind the delivery's acknowledgement with a deadline per push, so a workspace that hangs cannot
spend the platform's retry budget on a write that already committed. Each push reports an outcome
that is folded onto the record as it stands afterwards, because a push awaits a call into another
Worker and the durable object's input gate is open across it. And a terminal run event pushes the
cards it SETTLED alongside the run itself, so a card-subscribed gadget stops showing decisions
nobody can answer.

`addObserver` now admits a share when the observer's own account tier reaches everything the bound
tier reaches and masks no more, and refuses while the bound tier can read a telemetry sink. The
observer must hold an account this deployment minted, checked before any tier is resolved: an
unknown id resolves to the auto-provisioned tier, which is the tier nearly every account here
holds, so a viewer connected to another vendor would otherwise measure up as identical to the
owner. The `/rpc` door serves no hooks (it has no approval queue to register one with) and says so.

Three behaviour changes to know about. `GET /health` answers a new `os.limitations` array beside
`os.blockers`, carrying what a workspace could install and would find missing: a deployment that
does not export `CatFactoryHookController` stays discoverable and refuses hooks. An argument an
operation does not declare is now a refusal on both doors rather than a value dropped on the way
through, which is a break for any caller that was sending one; the refusal names what the operation
does take. And the `/webhook` 202 reports what it DISPATCHED (`hooks: { pushes, topics }`) rather
than what it delivered, because the fan-out no longer runs in front of the acknowledgement and a
count of pushes nobody has made yet is indistinguishable from a push every hook refused; the
per-hook counts are on `hooks_bound()`, where they always were.
