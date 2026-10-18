# Initiative: component stories for the SPA

**Status:** in progress (infrastructure PR open) · **Started:** 2026-10-15

> Tracker for a multi-PR initiative. Update the checklist at the end of each PR. When the last
> domain lands, convert this into an ADR and delete it.

## Goal

A story for every component and page in `frontend/app`, so each state a component can reach is
something a person (or an agent) can open, look at and check in light and dark, without a backend
and without driving the app into that state by hand. A story is also a test: the story lane
renders each one in headless Chromium with an axe check.

The stories already exist. They were written and checked on a local branch (one story per state
the code can reach, each judged from its render in both colour modes), and land here domain by
domain so each PR stays reviewable.

## Target pattern

The setup, the helpers and the conventions are in
[`docs/internal/storybook.md`](../internal/storybook.md). In short:

- one `Foo.stories.ts` beside each `Foo.vue`, titled `<Domain>/<Kind>/<Component>` from closed
  vocabularies, `Default` first (`scripts/check-story-titles.mjs` enforces the mechanical half);
- state from the board snapshot is seeded (`withSeed`, `seedSnapshot`); data a component loads is
  answered by msw from the route contract (`apiResponse` and its siblings), so a fixture of the
  wrong shape fails the typecheck or the response validation;
- a fixture several components need is shared in `app/stories/*.stories.mocks.ts` and parsed with
  its contract schema by `app/stories/fixtures.spec.ts`.

The first PR ships three examples, one per kind of data: `GateFailingCheckList` (args only),
`AgentStopButton` (a seed and the confirm dialog) and `FollowUpWindow` (a page with a snapshot and
an answered request).

## Checklist

Each domain PR brings its stories, the shared fixtures and request helpers they need, and their
rows in `fixtures.spec.ts`.

| PR  | Scope                                                                  | Story files | Stories | Link                                                        |
| --- | ---------------------------------------------------------------------- | ----------- | ------- | ----------------------------------------------------------- |
| 1   | Infrastructure, the patch, the guard, the nightly lane, three examples | 3           | 12      | (this PR)                                                   |
| 2   | Primitives and Shell                                                   | 36          | 129     | [#2384](https://github.com/kibertoad/cat-factory/pull/2384) |
| 3   | Board                                                                  | 43          | 205     | [#2385](https://github.com/kibertoad/cat-factory/pull/2385) |
| 4   | Inspector                                                              | 35          | 149     | [#2386](https://github.com/kibertoad/cat-factory/pull/2386) |
| 5   | Pipeline                                                               | 47          | 242     | [#2387](https://github.com/kibertoad/cat-factory/pull/2387) |
| 6   | Review and Run telemetry                                               | 31          | 166     | [#2388](https://github.com/kibertoad/cat-factory/pull/2388) |
| 7   | Documents and Setup                                                    | 36          | 164     | [#2389](https://github.com/kibertoad/cat-factory/pull/2389) |
| 8   | Settings, first half                                                   | 39          | 173     | [#2390](https://github.com/kibertoad/cat-factory/pull/2390) |
| 9   | Settings, second half                                                  | 41          | 177     | [#2391](https://github.com/kibertoad/cat-factory/pull/2391) |

The domain counts include the examples in PR 1 (one each in Review, Board and Pipeline).

Nine files get no stories, because they draw nothing of their own: `pages/index.vue` (the full
app at a route), the three route wrappers `pages/mcp-authorize.vue`, `pages/reset-password.vue`
and `pages/mcp-oauth-callback.vue` (their screens get the stories), the renderless hosts
`AppOverlayHost` and `StepResultViewHost` (each window gets its own), `AuthGate` (it needs the real
router and its screens get the stories), and `DependencyConnectOverlay` and `TaskDependencyEdges`
(both draw only during a drag on, or measured from, the board canvas, whose page story shows them).

`AccountPlatformAlertSettings` has no stories until #2393 is fixed: every state threw on its
empty select value, so each story showed Storybook's error display. Other stories leave out the
states that hit the same bug, and cite the issue in their header.

## Gotchas

- **The preset is patched.** One upstream bug, described in the internal doc and linked from
  `pnpm-workspace.yaml`: nuxt-modules/storybook#1140, the empty canvas id under addon-vitest.
  Remove the patch when a release fixes #1140; until then a bump of `@storybook-vue/nuxt` fails
  the install.
- **The story lane is not per PR.** Its nightly is paused until #2442. The whole tree takes
  about 10 minutes. Running it without browser isolation took about 2 and was rejected:
  shuffled, 2 of 4 runs timed out on stories that pass alone.
- **Stories must not ship.** `@cat-factory/app` publishes `app/`, so its `files` excludes
  `app/stories` and `app/**/*.stories.ts`. Before that, the package carried 362 story files.
- **State that survives a story:** cookies (cleared in `beforeEach`), the modular registry (reset
  in `beforeEach`), the confirm dialog (cancelled by `withConfirmDialog`). Local storage is not
  cleared.
- **The stories found UI defects** (copy that contradicts the state, em-dashes in the catalog, raw
  backend messages shown inline, a few layout cuts). They are not fixed in these PRs, which only
  add stories; they are reported separately.
