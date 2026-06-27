---
'@cat-factory/app': patch
---

Pin `vite.optimizeDeps.include` for the SPA's heavy dependencies. After the board page's
panels were moved to `defineAsyncComponent(() => import(...))`, Vite's startup dependency
scan (static-import-only) no longer crawled into them, so deps like `@vue-flow/*`,
`@vueuse/core`, `markdown-it`, `wretch`, `valibot` and the `@toad-contracts` client were
discovered at runtime instead — each discovery triggering a dep re-optimization + full
page reload. In the Playwright e2e run (which drives `nuxt dev`) a mid-test reload aborts
an in-flight `page.goto` with `net::ERR_ABORTED`, hanging a spec to its 180s timeout and
inflating the e2e job from ~75s to ~4.5min. Pre-bundling the list at startup keeps dev/e2e
deterministic while retaining the production code-splitting win.
