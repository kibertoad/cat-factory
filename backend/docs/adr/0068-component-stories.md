# ADR 0068: Component stories for the SPA

- **Status:** Accepted (implemented)
- **Date:** 2026-10-17
- **Context layer:** `frontend/storybook` (`@cat-factory/storybook`, the Storybook config and its
  vitest story lane), `frontend/app/app/stories/` (the shared fixtures and request helpers), the
  `*.stories.ts` files beside the SPA's components, `scripts/check-story-titles.mjs`, and the
  nightly story workflow `.github/workflows/stories.yml`. Authoring guide: [`docs/internal/storybook.md`](../../../docs/internal/storybook.md).

## Context

A component in `frontend/app` can reach many states: loading, failed, empty, a role that may not
write, a run parked on a gate. Before this, the only way to see one of them was to drive the app
into it by hand against a real backend, and the e2e suite covers only a few. Nothing let a person
or an agent open a given state, look at it in light and dark, and check it.

## Decision

Every component and page in `frontend/app` that draws something of its own has a `Foo.stories.ts`
beside its `Foo.vue`, with one story per state the code can reach. The files that have none are
listed under Consequences. 308 story files with 1404 stories landed in nine PRs, one for
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
- **The lane is nightly, and runs on a PR that changes the lane.** The whole tree takes about 10
  minutes on a laptop and about half an hour in CI, with browser isolation. A run without
  isolation took about 2 minutes, but 2 of 4 shuffled runs timed out on stories that pass alone,
  so isolation stays and the lane does not run on every PR.

## Rationale

- One file per component, beside it, keeps a story next to the code it shows, and a closed title
  vocabulary keeps the sidebar a map of the product, not of the component tree.
- Fixtures typed and parsed against the contracts mean a story cannot show a row the API would
  refuse, and a contract change breaks the story that depends on it.

## Consequences

- **The preset was patched until 10.0.3.** `@storybook-vue/nuxt@10.0.2` carried a pnpm patch for
  nuxt-modules/storybook#1140, the empty canvas id under addon-vitest. The 10.0.3 release fixes
  it, so the preset now runs unpatched.
- **Stories must not ship.** `@cat-factory/app` publishes `app/`, so its `files` excludes
  `app/stories` and `app/**/*.stories.ts`.
- **State can survive a story.** Cookies and the modular registry reset in `beforeEach`, and the
  confirm dialog is cancelled by `withConfirmDialog`. Local storage is not cleared.
- **Some states have no story.** Ten files draw nothing of their own: `app.vue`, `pages/index.vue`,
  the route wrappers `pages/mcp-authorize.vue`, `pages/reset-password.vue` and
  `pages/mcp-oauth-callback.vue`, the renderless hosts `AppOverlayHost` and `StepResultViewHost`,
  `AuthGate`, `DependencyConnectOverlay` and `TaskDependencyEdges`. The shells `AppModal` and
  `TakeoverShell` draw only around the content a consumer gives them, so the stories of the modals
  and takeovers inside them show them. `AccountPlatformAlertSettings` has no stories of its own yet;
  the admin story of `AccountTeamSettings` shows it.
- **The stories found product defects.** Writing them surfaced wrong states, swallowed errors,
  raw backend text and copy problems. These PRs only add stories, so the defects are reported as
  issues (#2369, #2393 to #2396, #2405, and the follow-ups filed from the same work).
