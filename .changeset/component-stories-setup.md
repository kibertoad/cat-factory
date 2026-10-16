---
'@cat-factory/app': patch
---

The package no longer ships component stories or their shared fixtures: `files` excludes
`app/stories` and `app/**/*.stories.ts`, which the private `@cat-factory/storybook` package
in `frontend/storybook` renders.
