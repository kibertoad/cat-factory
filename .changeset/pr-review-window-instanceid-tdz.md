---
'@cat-factory/app': patch
---

Fix the PR deep-review window ("Review & approve") throwing `ReferenceError: can't access lexical declaration 'instanceId' before initialization` on every open, and remove the whole bug class at its source.

`useResultView` fires `onOpen` synchronously from its `immediate` watch — during the caller's `setup`, before the `const { … } = useResultView(…)` destructure is assigned — so a callback that referenced those return refs (`PrReviewWindow`'s `instanceId`) hit their temporal dead zone and threw. `onOpen` now receives a fully-resolved `OpenResultView` context (`blockId` / `instanceId` / `stepIndex` / `stage`), so a loader takes what it needs from its argument and never reaches back into a not-yet-initialised ref (or the store). This also drops the store-reach workaround `BrainstormWindow` had carried for the same reason.
