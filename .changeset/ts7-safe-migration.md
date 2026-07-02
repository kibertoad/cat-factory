---
---

chore: migrate the remaining non-Vue, non-image-payload workspaces to TypeScript 7

Bumps `typescript` from `^6.0.3` to `7.0.1-rc` in `@cat-factory/deploy-backend`,
`@cat-factory/benchmark-harness`, and `@cat-factory/smoketest-harness` — all private,
changeset-ignored packages whose typecheck runs on the plain native compiler. This
brings every workspace onto TS7 except the two Nuxt/Vue packages (`@cat-factory/app`,
`@cat-factory/deploy-frontend`), which are blocked until `vue-tsc`/Volar support the
native compiler, and the two container-image payloads (`executor-harness`,
`deploy-harness`), which move separately as a deliberate image-tag-bumping change.
