---
'@cat-factory/app': patch
'@cat-factory/storybook': patch
---

Fix the component story lane failing random files in CI. A `Loading` story's response now answers at
once with a body that never ends, instead of never returning, so msw's service worker no longer
holds an event open until Chromium stops it and fails every request it was passing on. The stories
go back to msw 2.15, whose worker does not hold events open either (mswjs/msw#2801).
