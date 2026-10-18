---
'@cat-factory/app': patch
'@cat-factory/storybook': patch
---

Component story plays wait for the page's requests before they look for the state their story
renders, instead of giving up after one second, so a slow CI machine no longer fails them. The first
story of each stories file no longer pays for the frame's first Nuxt boot inside its test timeout:
the test lane runs an empty story first, and the app's pages are empty in Storybook. The story lane
skips release PRs.
