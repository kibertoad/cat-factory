---
'@cat-factory/app': patch
---

Fix the PR deep-review window ("Review & approve") throwing `ReferenceError: can't access lexical declaration 'instanceId' before initialization` on every open.

`PrReviewWindow`'s `useResultView` `onOpen` callback read the destructured `instanceId` ref, but `useResultView` invokes `onOpen` synchronously from its `immediate` watch — before that `const` is initialised — so it hit the temporal dead zone and threw. It now reads the id off `ui.resultView` inside `onOpen`, matching the documented workaround already in `BrainstormWindow`.
