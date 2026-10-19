---
'@cat-factory/storybook': patch
---

Component story plays wait for the story's API requests before they look for the state their story
renders, instead of giving up after one second. The first story of each stories file no longer pays
for the frame's first Nuxt boot inside its test timeout: the test lane runs an empty story first,
and the app's pages are empty in Storybook.
