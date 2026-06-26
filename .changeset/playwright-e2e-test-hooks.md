---
'@cat-factory/app': patch
---

Fix a build-breaking Vue SFC error in 13 integration panels/modals: their
`IntegrationBackTitle` `@back` handler was written as two statements across newlines
(`open = false` ⏎ `ui.openIntegrations()`), which the Vue 3.5 / Vite SFC compiler rejects
(`Unexpected token, expected ","`) — both `nuxt dev` and `nuxt build` failed. Joined each
into a single `;`-separated statement; no behaviour change.

Also add `data-testid` / `data-status` test hooks to the board components (board canvas,
task card, decision badge + decision modal) so the new `@cat-factory/e2e` Playwright suite
can target stable selectors. Additive only.
