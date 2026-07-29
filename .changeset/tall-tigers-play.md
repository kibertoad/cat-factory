---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Classify agent kinds into three tiers (`basic` / `intermediate` / `advanced`) and open the two
surfaces that enumerate the whole catalog — the pipeline builder's palette and a model preset's
per-agent overrides — on the basic tier, with a control on each to widen the view.

Both surfaces listed every kind the deployment knows about: ~30 palette blocks across six
categories, and a per-agent override row for each of those plus the engine kinds that run a model.
That is the full roster for someone assembling their first pipeline, and the everyday kinds
(architect, coder, tester, documenter) are scattered through it. The tier is the axis that was
missing — categories say what a kind is FOR, not how far off the main path it sits.

Tiers are CUMULATIVE, which is the main decision to sanity-check: the control is a level dial
(`basic` → `intermediate` → `advanced`), not a set of exclusive filters, so the widest level shows
the entire catalog and there is no separate "show all" option that would duplicate it. Exclusive
filters were rejected because a real pipeline mixes tiers — reaching for one specialist kind should
not hide the coder while you do it.

The vocabulary, the default and the predicate live in `@cat-factory/contracts` beside
`purposeAllowsAgentCategory`, so a deployment-registered kind's declared `presentation.tier` and the
SPA's own built-ins are read by one rule. A kind that declares no tier is treated as `intermediate`:
`basic` would let anything unclassified into the default view, and `advanced` would bury a kind a
deployment deliberately installed. Built-ins are not allowed that freedom — `catalog.spec.ts` fails
if one forgets its tier, since the silent outcome would be it vanishing from the default view for
no stated reason.

Two things worth looking at when reviewing. The model-preset list always keeps a kind the edited
preset already pins a model for, whatever the tier — that override may have been written by a
teammate, by the API, or by this user at a wider tier, and a hidden row is one they can neither read
nor clear (the rule `showOverrideField` already states for a single field). And this is deliberately
NOT the basic/advanced interface mode: that tier decides which surfaces exist, this one decides how
much of one surface's catalog is listed, so the axes stay separate and the tier control is visible
in both interface modes — it is the only route to what it hides.

Compatibility note: `post-release-health` is tiered `intermediate` rather than `advanced` even
though it is the most specialist gate, because the palette already offers it only once an
observability integration is connected, and that connection is a stronger statement of intent than
the tier.
