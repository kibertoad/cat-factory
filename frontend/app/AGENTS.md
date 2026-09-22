# `@cat-factory/app`: the SPA (Nuxt 4 layer)

The user-facing app, packaged as a **reusable Nuxt 4 layer** a deployment consumes with
`extends: ['@cat-factory/app']`. Thin client, no business logic: every mutation calls the backend
Worker and the Pinia stores hydrate from server snapshots and live WebSocket updates. The full
guide is [`README.md`](./README.md); this file is the short orientation and the pointers Claude
Code loads as instructions (via the sibling [`CLAUDE.md`](./CLAUDE.md)).

**Entry:** `nuxt.config.ts` (the layer's `main`). Source lives under `app/` (the Nuxt srcDir):
`app.vue` is the root; `app/pages/index.vue` is the board, beside three standalone routes
(`mcp-authorize.vue`, `mcp-oauth-callback.vue`, `reset-password.vue`).

**Where things live:**

- `app/components/`: UI grouped by area (`board`, `panels`, `palettes`, `layout`, `settings`,
  `common`, and one folder per surface). Read [`README.md` → Key UI surfaces](./README.md#key-ui-surfaces).
- `app/stores/`: Pinia stores, one per feature domain. `app/composables/`: `useApi`,
  `useWorkspaceStream` (WebSocket sync) and the rest. `app/utils/`: pure helpers.
- `app/assets/css/tokens.css`: the app's own theme tokens. `app/docs/architecture.md`: how the
  store sync works.
- `i18n/`: the locale catalogs. `scripts/`: the package's own i18n guards.

**Traps (all silent, all in [`README.md`](./README.md)):**

- **Import a layer component by path before using it**, never a bare tag; auto-registration is a
  coincidence and an unresolved tag renders nothing. [Rule](./README.md#always-import-a-layer-component-explicitly),
  guarded by `scripts/check-component-imports.mjs`.
- **Report a failed call through `usePipelineErrorToast().present`**, never a hand-built
  `toast.add`. [Rule](./README.md#every-failure-toast-goes-through-one-funnel).
- **Seed modal-open state with `onModalOpen`**, never a bare `watch(open)`.
  [Rule](./README.md#a-panel-that-seeds-state-on-open-uses-onmodalopen-never-a-bare-watchopen).
- **Colour through theme tokens**, never a raw Tailwind hue or a fixed numbered alias.
  [Rule](./README.md#colour-through-theme-tokens-never-a-fixed-palette-shade), guarded by
  `scripts/check-frontend-palette.mjs`.

**Nuxt UI guidance:** the vendored [`nuxt-ui` skill](../../.claude/skills/nuxt-ui/SKILL.md) teaches
WHEN to use which component and HOW to build well; the [`nuxt-ui` MCP server](../../.mcp.json)
(`https://ui.nuxt.com/mcp`) answers WHAT a component accepts (props, slots, theme files, examples).
Where the SPA's own rules override the skill: [`README.md` → Nuxt UI](./README.md#nuxt-ui-agent-tooling-and-where-the-spa-overrides-the-skill).

## Verify

The frontend has no `dev` or `lint` script of its own: it is consumed through `extends`, and linting
is whole-tree from the root (CLAUDE.md). Run these where stated:

- `pnpm dev:frontend` from the repo root, with `NUXT_PUBLIC_API_BASE` pointing at a running Worker
  (the dev server lives in `deploy/frontend`).
- `pnpm exec turbo run typecheck --filter=@cat-factory/app` from the repo root (typecheck goes
  through Turbo).
- `pnpm exec vitest run <file>` from `frontend/app`, naming the spec your change touched.
- `pnpm lint` from the repo root (oxlint + oxfmt over the whole tree, once).
- `pnpm --filter @cat-factory/app i18n:check` and `i18n:parity` when you touch copy or the catalog.
- `node scripts/check-component-imports.mjs`, `node scripts/check-frontend-palette.mjs`,
  `node scripts/check-file-size.mjs` from the repo root (install-free guards CI runs).

**See also:** [`README.md`](./README.md), [`app/docs/architecture.md`](./app/docs/architecture.md),
[`@cat-factory/contracts`](../../backend/packages/contracts/AGENTS.md) (the shared wire types).
