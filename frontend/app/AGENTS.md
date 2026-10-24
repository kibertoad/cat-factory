# `@cat-factory/app`: the SPA (Nuxt 4 layer)

The user-facing app, packaged as a **reusable Nuxt 4 layer** a deployment consumes with
`extends: ['@cat-factory/app']`. Thin client, no business logic: every mutation calls the backend
Worker and the Pinia stores hydrate from server snapshots and live WebSocket updates. The full
guide is [`README.md`](./README.md); this file is the short orientation and the pointers a coding
agent loads as instructions when it reads a file here.

**Entry:** `nuxt.config.ts` (the layer's `main`). Source lives under `app/` (the Nuxt srcDir):
`app.vue` is the root; `app/pages/index.vue` is the board and its queue view, beside three
standalone routes (`mcp-authorize.vue`, `mcp-oauth-callback.vue`, `reset-password.vue`).

**Where things live:**

- `app/components/`: UI grouped by area (`board`, `panels`, `palettes`, `layout`, `settings`,
  `common`, and one folder per surface). Read [`README.md` → Key UI surfaces](./README.md#key-ui-surfaces).
- `app/stores/`: Pinia stores, one per feature domain. `app/composables/`: `useApi`,
  `useWorkspaceStream` (WebSocket sync) and the rest. `app/utils/`: pure helpers.
- `app/assets/css/tokens.css`: the app's own colour tokens; `type.css`: its two type steps below
  `text-xs`. `app/docs/architecture.md`: how the store sync works.
- `i18n/`: the locale catalogs. `scripts/`: the package's own i18n guards.

**Traps (all silent, all in [`README.md`](./README.md)):**

- **Import a layer component by path before using it**, never a bare tag; auto-registration is a
  coincidence and an unresolved tag renders nothing. [Rule](./README.md#always-import-a-layer-component-explicitly),
  guarded by `scripts/check-component-imports.mjs`.
- **Report a failed call through `usePipelineErrorToast().present`, every other toast through
  `useActionToast()`**, never a hand-built `toast.add`; loading is `:loading`, `USkeleton` or
  `<Spinner>`, empty is `<EmptyState>`. [Rule](./README.md#every-failure-toast-goes-through-one-funnel),
  guarded by `scripts/check-frontend-feedback.mjs`.
- **Seed modal-open state with `onModalOpen`**, never a bare `watch(open)`.
  [Rule](./README.md#a-panel-that-seeds-state-on-open-uses-onmodalopen-never-a-bare-watchopen).
- **Colour through theme tokens**, never a raw Tailwind hue or a fixed numbered alias.
  [Rule](./README.md#colour-through-theme-tokens-never-a-fixed-palette-shade), guarded by
  `scripts/check-frontend-palette.mjs`.
- **Type through named steps** (`text-2xs` / `text-3xs` below `text-xs`), never a `text-[11px]`
  literal, which does not scale with a theme's `fontSize`; a section eyebrow is
  `common/SectionLabel.vue`. [Rule](./README.md#type-through-named-steps-never-a-pixel-literal),
  guarded by `scripts/check-frontend-type-scale.mjs`.
- **Radius through any `rounded-*` step** (`main.css` binds the whole scale onto `--ui-radius`),
  never an arbitrary value; in CSS, `var(--ui-radius)` or a `calc()` of it, never a `--radius-*`
  variable or a literal. [Rule](./README.md#radius-through-the-theme-scale), guarded by
  `scripts/check-frontend-radius.mjs`.
- **A modal is `<AppModal size="prompt|form|wide">`**, never a raw `UModal` and never a `max-w-*` of
  its own; a workbench surface that waits on #2359 says so in a `workbench-width-ok:` comment.
  [Rule](./README.md#modals-open-at-a-named-width), guarded by `scripts/check-frontend-geometry.mjs`.
- **A control is its Nuxt UI component** (`UButton`, `UInput`, `USelect`, `UTable`, `UCollapsible`,
  `UForm`, `ULink`), never the raw element; an icon-only button is `common/IconButton.vue`, which
  owns the tooltip. [Rule](./README.md#a-control-is-its-nuxt-ui-component), guarded by
  `scripts/check-frontend-primitives.mjs`.
- **Buttons and badges state only what differs from Nuxt UI's default** (`primary solid md`,
  stated in `app.config.ts`): a primary action carries no props, ONE solid per view (no two
  solid siblings), and quiet chrome says `color="neutral" variant="ghost" size="xs"`.
  [Rule](./README.md#buttons-and-badges-follow-one-variant-policy), guarded by
  `scripts/check-frontend-variants.mjs`.
- **Switch views inside a surface with `UTabs`**, never a row of `UButton`s or a hand-written
  `role="tablist"`: only `UTabs` gives the arrow keys. A row that SETS A VALUE is a picker, not a
  tab bar. [Rule](./README.md#switch-views-inside-a-surface-with-utabs), guarded by
  `scripts/check-frontend-tabs.mjs`.
- **A component keeps its `Foo.stories.ts` current**: one story per state it can draw (`Default`
  first, then `Empty`, `Loading`, `Failed`, then its own), so a new component or a new state adds
  its story, unless the component draws nothing of its own.
  [Conventions](../../docs/internal/storybook.md). Review enforces the rule;
  `scripts/check-story-titles.mjs` guards only the titles and the file placement.

**Nuxt UI guidance:** the vendored [`nuxt-ui` skill](../../.claude/skills/nuxt-ui/SKILL.md) teaches
WHEN to use which component and HOW to build well; the [`nuxt-ui` MCP server](../../.mcp.json)
(`https://ui.nuxt.com/mcp`) answers WHAT a component accepts (props, slots, theme files, examples).
The platform's own coder agents get the same skill + server through `registerNuxtUiCapability`
(`backend/packages/agents/src/agents/kinds/nuxt-ui/`), which inlines THIS vendored skill, so the two
never drift. Where the SPA's own rules override the skill: [`README.md` → Nuxt UI](./README.md#nuxt-ui-agent-tooling-and-where-the-spa-overrides-the-skill).

## Verify

The frontend has no `dev` or `lint` script of its own: it is consumed through `extends`, and linting
is whole-tree from the root (AGENTS.md). Run these where stated:

- `pnpm dev:frontend` from the repo root, with `NUXT_PUBLIC_API_BASE` pointing at a running Worker
  (the dev server lives in `deploy/frontend`).
- `pnpm exec turbo run typecheck --filter=@cat-factory/app` from the repo root (typecheck goes
  through Turbo).
- `pnpm exec vitest run <file>` from `frontend/app`, naming the spec your change touched.
- `pnpm lint` from the repo root (oxlint + oxfmt over the whole tree, once).
- `pnpm --filter @cat-factory/app i18n:check` and `i18n:parity` when you touch copy or the catalog.
- `pnpm --filter @cat-factory/storybook run test:stories <file>` from the repo root, naming the
  stories file your change touched. CI runs the story lane only nightly, so a story that fails to
  render or fails axe merges green otherwise.
- `node scripts/check-component-imports.mjs`, `node scripts/check-frontend-palette.mjs`,
  `node scripts/check-frontend-type-scale.mjs`, `node scripts/check-frontend-radius.mjs`,
  `node scripts/check-frontend-primitives.mjs`, `node scripts/check-frontend-variants.mjs`,
  `node scripts/check-frontend-feedback.mjs`, `node scripts/check-frontend-geometry.mjs`,
  `node scripts/check-frontend-tabs.mjs`, `node scripts/check-story-titles.mjs`,
  `node scripts/check-file-size.mjs` from the repo root (install-free guards CI runs).

**See also:** [`README.md`](./README.md), [`app/docs/architecture.md`](./app/docs/architecture.md),
[`@cat-factory/contracts`](../../backend/packages/contracts/AGENTS.md) (the shared wire types).
