---
'@cat-factory/acceptance-kit': minor
---

Publish the reset plan/apply machinery, so a suite does not re-derive the rules that fail quietly.

The kit shipped every small seam a `reset` command needs (`SuiteIdentity.resetCommand`, `listPasses`,
`readLatestPointer`, `scrubbed`) and not the reset itself, so a deployment building its own suite
copied roughly 1,360 lines to get one. `planReset`, `applyReset`, `parseResetArgs`,
`formatResetPlan`, `formatResetReport`, `resetSucceeded` and the `ResetClient` port are now exported,
generic over a suite's own ledger fact type.

The kit owns the four decisions that go wrong silently: unfinished tasks are deleted before their
frame (the frame delete refuses over them) while finished ones ride its cascade, a pass's ledger is
never removed while a frame it names is still standing, the `latest` pointer goes both when it names
a pass being removed and when it names nothing, and the apply consumes the plan the preview showed. A
`404` counts as an outcome.

A suite supplies what only it knows, as three callbacks on `ResetInput`: `target` (which frames this
configuration asks about, in its own words, plus anything it could not free or read),
`ledgerServiceIds`, and `leftovers`. `parseResetArgs` takes a suite's extra flags and hands them back
un-interpreted.

Two rules read directly rather than through a proxy. The `latest` pointer rule no longer carries an
`--all` clause: that scope plans every pass in the state directory, so a pointer under it either
names one of them or names none, and reading the rule itself also removes the dangling pointer a
CONFIGURED reset used to leave behind. Which half put it there rides the plan and the report as a
`PointerReason`, so the two sentences never borrow each other's words. And `parseResetArgs` throws on
a `flags` declaration it could not hand back (a name it acts on itself, or one spelled without its
dashes, which it would match ahead of the positional) rather than shadowing the suite's meaning with
its own on every invocation.

Internal break for anyone who copied the private version: `FrameReason` no longer carries
suite-specific members (a suite's reason is a phrase the kit prints), `ResetPlan.stuck` /
`ResetPlan.unlinked` are now `blockers` / `notes`, `ResetReport.pointerRemoved` is now `pointer`
(the removed file and why, or null), and `ResetClient` has four calls rather than five.
Design record: `backend/docs/adr/0061-acceptance-kit-reset-machinery.md`.
