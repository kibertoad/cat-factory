import { fileURLToPath } from 'node:url'
import type { NuxtPage } from 'nuxt/schema'

const emptyPage = fileURLToPath(new URL('./.storybook/EmptyPage.vue', import.meta.url))

/** Give every page, nested ones included, the empty page's file. */
function emptyPages(pages: NuxtPage[]): void {
  for (const page of pages) {
    page.file = emptyPage
    if (page.children) emptyPages(page.children)
  }
}

// The Nuxt app the stories render in: the `@cat-factory/app` layer and nothing else. It is a
// workspace package of its own, not part of `deploy/frontend`, so that the deployment template
// stays copyable outside this repository. Setup and conventions: docs/internal/storybook.md.
export default defineNuxtConfig({
  extends: ['@cat-factory/app'],
  hooks: {
    // Every route keeps its path and shows an empty page. A story frame's URL is
    // `/?sessionId=…&iframeId=…`, the app's `/` route, which Nuxt's router resolves while the
    // preset builds each story's Nuxt app; a real page there would load the whole app it imports
    // into every stories file. No story renders a page, and `useRoute()` reads the same route.
    'pages:extend'(pages) {
      emptyPages(pages)
    },
  },
})
