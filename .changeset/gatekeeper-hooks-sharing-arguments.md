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

`addObserver` now admits a share when the observer's own account tier reaches everything the bound
tier reaches and masks no more, and refuses while the bound tier can read a telemetry sink. The
`/rpc` door serves no hooks (it has no approval queue to register one with) and says so.

Two behaviour changes to know about. `GET /health` answers a new `os.limitations` array beside
`os.blockers`, carrying what a workspace could install and would find missing: a deployment that
does not export `CatFactoryHookController` stays discoverable and refuses hooks. And an argument an
operation does not declare is now a refusal on both doors rather than a value dropped on the way
through, which is a break for any caller that was sending one; the refusal names what the operation
does take.
