---
'@cat-factory/storybook': patch
---

Cap the story lane at 4 workers. Without a cap, Vitest opened one Chromium page per core (at most
12), which held the whole CPU on a large machine and made the first story of each file time out
under load. 4 workers ran as fast as 12 on a 40-file batch. Pass `--maxWorkers` to override it.
