// The Nuxt app the stories render in: the `@cat-factory/app` layer and nothing else. It is a
// workspace package of its own, not part of `deploy/frontend`, so that the deployment template
// stays copyable outside this repository. Setup and conventions: docs/internal/storybook.md.
export default defineNuxtConfig({
  extends: ['@cat-factory/app'],
})
