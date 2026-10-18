import { fileURLToPath } from 'node:url'

const emptyPage = fileURLToPath(new URL('./.storybook/EmptyPage.vue', import.meta.url))

// The Nuxt app the stories render in: the `@cat-factory/app` layer and nothing else. It is a
// workspace package of its own, not part of `deploy/frontend`, so that the deployment template
// stays copyable outside this repository. Setup and conventions: docs/internal/storybook.md.
export default defineNuxtConfig({
  extends: ['@cat-factory/app'],
  hooks: {
    // Every route keeps its path and shows an empty page. A story frame's URL is
    // `/?sessionId=…&iframeId=…`, which is the app's `/` route, and Nuxt's router resolves it
    // while the preset builds each story's Nuxt app. So the first story of every stories file
    // loaded `pages/index.vue` and the whole app it imports, about 170 modules, inside its test
    // timeout. No story renders a page, and `useRoute()` still reads the same route.
    'pages:extend'(pages) {
      for (const page of pages) page.file = emptyPage
    },
  },
})
