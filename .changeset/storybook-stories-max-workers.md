---
'@cat-factory/storybook': patch
---

Cap the story lane at 3 workers, the count Vitest gives CI's 4-vCPU runner. Without a cap, Vitest
opened one Chromium page per core but one (at most 12), which held the whole CPU on a large machine.
Pass `--maxWorkers` to override it.
