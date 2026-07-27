---
'@cat-factory/orchestration': patch
---

Extract `BoardService.removeBlock`'s side-table reclaims into `board/removal-cascade.ts`.

Behaviour-neutral code motion. The delete path has to reclaim every row keyed by a doomed BLOCK id
— today the account-owned service plus its mounts, and the initiative entity — or leave a phantom
that no UI can reach and every list read keeps returning. That is a cohesive concern of its own and
it is where `removeBlock` grows: `BoardService` was ~20 lines under its file-size budget, so the
next block-keyed table would have pushed it over. It now takes a small deps object of the optional
repositories and the service keeps a one-line delegate, following the `RunDispatcher` controller
extractions.
