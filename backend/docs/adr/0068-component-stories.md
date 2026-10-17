# ADR 0068: Component stories for the SPA

- **Status:** Accepted (implemented)
- **Date:** 2026-10-17
- **Context layer:** `frontend/storybook` (`@cat-factory/storybook`, the Storybook config and its
  vitest story lane), `frontend/app/app/stories/` (the shared fixtures and request helpers), the
  `*.stories.ts` files beside the SPA's components, `scripts/check-story-titles.mjs`, and the
  nightly story workflow. Authoring guide: [`docs/internal/storybook.md`](../../../docs/internal/storybook.md).

## Context

A component in `frontend/app` can reach many states: loading, failed, empty, a role that may not
write, a run parked on a gate. Before this, the only way to see one of them was to drive the app
into it by hand against a real backend, and the e2e suite covers only a few. Nothing let a person
or an agent open a given state, look at it in light and dark, and check it.

## Decision

Every component and page in `frontend/app` has a `Foo.stories.ts` beside its `Foo.vue`, with one
story per state the code can reach. 308 story files with 1403 stories landed in nine PRs, one for
the infrastructure (#2367) and one per domain (#2384 to #2391).

- **Titles come from closed vocabularies.** `<Domain>/<Kind>/<Component>`, with `Default` first
  and one state vocabulary (`Default`, `Empty`, `Loading`, `Failed`). The failed state is not
  named `Error`, because `export const Error` shadows the global constructor for the whole file.
  A result window or full-screen overlay that mounts alone is a Page; a part of one is a
  Component. `scripts/check-story-titles.mjs` checks the mechanical half.
- **Data comes from the contracts.** State from the board snapshot is seeded (`withSeed`,
  `seedSnapshot`). Data a component loads is answered by msw from the route contract
  (`apiResponse`, `apiFailure`, `apiRefusal` and siblings), so a fixture of the wrong shape fails
  the typecheck or the response validation. A refusal copies the status, code and message of the
  handler that sends it.
- **Shared fixtures are parsed.** A fixture several stories need lives in
  `app/stories/*.stories.mocks.ts`, follows the backend seed it copies, and has a row in
  `app/stories/fixtures.spec.ts` that parses it with its contract schema.
- **A story is a test.** The story lane renders each story in headless Chromium with an axe
  check. A play ends by waiting for the state its story is named after.
- **The lane is nightly.** The whole tree takes about 10 minutes with browser isolation. A run
  without isolation took about 2 minutes, but 2 of 4 shuffled runs timed out on stories that pass
  alone, so isolation stays and the lane does not run per PR.

## Rationale

- One file per component, beside it, keeps a story next to the code it shows, and a closed title
  vocabulary keeps the sidebar a map of the product, not of the component tree.
- Fixtures typed and parsed against the contracts mean a story cannot show a row the API would
  refuse, and a contract change breaks the story that depends on it.
- Domain-sized PRs kept each review readable. A shared fixture is byte-identical on every branch,
  which made merges mechanical except for the rows of `fixtures.spec.ts`.

## Consequences

- **The preset is patched.** `@storybook-vue/nuxt@10.0.1` carries a pnpm patch for two upstream
  bugs: nuxt-modules/storybook#1138 (Nuxt 4.6, fixed by #1139, merged on 2026-10-16) and #1140
  (the empty canvas id under addon-vitest, still open). The internal doc and
  `pnpm-workspace.yaml` link them. A bump of the preset fails the install until the patch is
  rebased or removed, and it can be removed only when a release fixes both.
- **Stories must not ship.** `@cat-factory/app` publishes `app/`, so its `files` excludes
  `app/stories` and `app/**/*.stories.ts`.
- **State can survive a story.** Cookies and the modular registry reset in `beforeEach`, and the
  confirm dialog is cancelled by `withConfirmDialog`. Local storage is not cleared.
- **Some states have no story.** Nine files draw nothing of their own: `pages/index.vue`, the
  route wrappers `pages/mcp-authorize.vue`, `pages/reset-password.vue` and
  `pages/mcp-oauth-callback.vue`, the renderless hosts `AppOverlayHost` and `StepResultViewHost`,
  `AuthGate`, `DependencyConnectOverlay` and `TaskDependencyEdges`. `AccountPlatformAlertSettings`
  has no stories until #2393 is fixed, and other stories leave out the states that hit the same
  bug.
- **The stories found product defects.** Writing them surfaced wrong states, swallowed errors,
  raw backend text and copy problems. These PRs only add stories, so the defects are reported as
  issues (#2369, #2393 to #2396, #2405, and the follow-ups filed from the same work).
