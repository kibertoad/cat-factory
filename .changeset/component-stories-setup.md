---
'@cat-factory/app': patch
---

The package no longer ships component stories or their shared fixtures: `files` excludes
`app/stories` and `app/**/*.stories.ts`, which arrive with the Storybook setup in
`deploy/frontend`. `@storybook/vue3` and `storybook` are new dev dependencies, so nothing changes
for a consumer.
