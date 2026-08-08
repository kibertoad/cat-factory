---
'@cat-factory/agents': minor
'@cat-factory/server': minor
---

Pin the harness contract that two packages' comments claimed but nothing enforced.

`safeDirSegment` plus the `owner__name` join, and the four sentinel paths, exist once in the
executor harness and once in the backend, computed independently because the harness image can
depend on no workspace package. A new conformity suite asserts the pairs, in the style of the
existing `host-markdown` one. The backend half now lives in one module (`agents/harnessContract.ts`)
and `.cat-follow-ups.jsonl` gets the named constant its three siblings already had.

The suite is `test/**`-only, so it ships with no runner-image bump.
