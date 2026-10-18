---
'@cat-factory/app': patch
'@cat-factory/storybook': patch
---

Component story plays wait for the page's requests before they look for the state their story
renders, instead of giving up after one second, so a slow CI machine no longer fails them. The story
lane skips release PRs.
