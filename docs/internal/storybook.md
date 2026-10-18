# Component stories (Storybook)

The SPA's components have stories: one `Foo.stories.ts` beside each `Foo.vue` under
`frontend/app/app/components/`, in CSF3. Storybook runs from `frontend/storybook`, a private
workspace package whose Nuxt app extends the `@cat-factory/app` layer and nothing else. It is not
part of `deploy/frontend`, so the deployment template stays copyable outside this repository.

```bash
pnpm --filter @cat-factory/storybook run storybook        # http://localhost:6006
pnpm --filter @cat-factory/storybook run test:stories     # every story as a test
```

Stories cover what a component draws for a given state. Whether the backend agrees with what the
UI shows is the e2e suite's job ([`backend/internal/e2e/README.md`](../../backend/internal/e2e/README.md)):
a story fakes the data, and a fake cannot prove the two sides agree.

The work that adds stories domain by domain is tracked in
[`docs/initiatives/component-stories.md`](../initiatives/component-stories.md).

## The patch

`patches/@storybook-vue__nuxt@10.0.1.patch` fixes two upstream bugs in the Storybook preset, and
`pnpm-workspace.yaml` applies it. It pins the exact version, so a bump fails the install instead
of applying a stale fix. Remove the patch when a release fixes both.

1. **Every story dies with `NUXT_E1001` on Nuxt 4.6.** Nuxt 4.6 keeps the client app context in
   `globalThis.__nuxt_app_ctx__` (`nuxt/dist/app/internal/context.js`). The preset still writes
   the story's Nuxt app to the `unctx` registry, so `useNuxtApp()` finds nothing and the first
   plugin to run throws. It fails with no Nuxt modules at all. Upstream:
   [nuxt-modules/storybook#1138](https://github.com/nuxt-modules/storybook/issues/1138), fixed
   by the open [#1139](https://github.com/nuxt-modules/storybook/pull/1139) on the `10.x` branch.
   The patch writes to the registry Nuxt 4.6 reads.
2. **Every story test throws "StoryContext is not provided".** `setup()` takes its key from
   `storyContext.canvasElement.id`, and under `@storybook/addon-vitest` the canvas is a `div` with
   an empty `id`. Upstream:
   [nuxt-modules/storybook#1140](https://github.com/nuxt-modules/storybook/issues/1140). The key
   only names the story's Nuxt app, so the patch counts when the id is empty.

Any story whose component reads `useAppConfig()` (`Spinner` does) throws
`NUXT_E1001` if the first fix comes unstuck.

## Traps this setup already paid for

**`UApp` is IMPORTED in `preview.ts`, not written as a tag.** A decorator's template string is
compiled by the Vue runtime compiler, which knows nothing about Nuxt's auto-imports, so `<UApp>`
there becomes a literal `<uapp>` element that provides nothing and looks fine in the DOM. Nuxt UI's
overlays then render nothing: `IconButton` came out as an empty comment node, because its
`UTooltip` found no provider. The same goes for a story's own `render` template: a story that
writes a Nuxt UI tag there imports the component and lists it in `components`. Components inside
a `.vue` file are fine, because Vite compiles those with Nuxt's transform.

**`preview-head.html` stubs `window.__NUXT_COLOR_MODE__`.** The colour-mode module injects that
global through Nuxt's HTML template, and Storybook's `iframe.html` is not that template. Without it
the plugin reads `preference` off undefined and nothing renders. The plugin reads the global once
and seeds a story's `useColorMode()` from it when the story's Nuxt app starts. So `preview.ts`
changes the global's `preference` and `value` with each toolbar change, and its decorator sets the
running story's `useColorMode().preference`. If only the class changed, a dark story would report
`light`.

**`@nuxt/fonts` kills the process on the first `/_fonts/*` request.** Its Storybook branch calls
its own h3 handler with a bare `{ path }`, which throws out of a middleware nothing catches, and
Node exits. It only shows when a real browser asks for a font. `main.ts` answers `/_fonts/*` first
with a clean 404, and `preview-head.html` loads the typefaces from the CDN and sets `--font-sans`
and `--font-mono`, which the theme plugin normally sets at runtime from the theme document.
Without both halves, every story renders in the system font and looks fine.

**The colour-mode class on `<html>` is load-bearing, and its absence is silent.** `tokens.css` is
dark-first: every `--app-*` token has its dark value at `:root` and is overridden under `.light`.
With no class, every story rendered the dark tokens on a white page and nothing errored. The app
gets the class from the colour-mode module's inline script, which `iframe.html` never runs, so
`preview-head.html` does what that script does and `preview.ts` sets it again for each story from
the light/dark toolbar global. To diagnose a washed-out story, compare a few `--app-*` values in
`getComputedStyle(document.documentElement)` against the running SPA.

**The modular registry's consumer list outlives the story.** The preset builds a fresh Nuxt app
for each story and runs the plugins again, but `consumerModules` in `app/modular/registry.ts` is a
module-level array, so the second story threw `Duplicate module ID`. `preview.ts` resets it in
`beforeEach`, which runs before the preset's `setup()`. A decorator would be too late.

**A decorator that calls `story()` while rendering remounts the story.** Each `story()` call
returns a NEW component, so calling it inside a render function gave Vue a new component type on
every re-render, and the tree below was replaced: one card drag on the board canvas remounted the
canvas three times. Call `story()` once, in the decorator body (`preview.ts`, `withSeed`).

**A story file created after Storybook started adds no Tailwind classes until a restart.** The
running server does not scan a file created after it started. After adding story files, restart
Storybook before judging spacing.

**The stores exist before the seed runs.** The app's plugins create about 18 stores when the
story's Nuxt app starts. A store that reads something once, at creation, has already read it: a
seed that sets the deployment's tier pin changes nothing. Call `$dispose()` on the store and delete
its state, so the component creates a fresh one.

**Storybook runs standalone.** `@nuxtjs/storybook` is NOT in `nuxt.config`. Adding it boots
Storybook inside `nuxt dev` at `/_storybook`, which changes the dev server for everyone and runs a
second Vite server in the same process. The framework preset is what renders the stories.

## Conventions

### Layers

| Layer     | What mounts                       | Data                           |
| --------- | --------------------------------- | ------------------------------ |
| Component | one component, no router or shell | args, a seed, or a snapshot    |
| Page      | one surface without the app shell | a snapshot plus faked requests |
| Scene     | the full app at a route           | not used                       |

Pick the layer first: it decides what mounts, what fakes the data, and who the story is for.

A result window or a full-screen overlay that mounts alone over a seeded snapshot is a Page, even
when it fakes no request: it is a whole surface the user opens, not a part of one. A piece of such
a surface (a section, a card, a list) is a Component.

### Titles are product language

```
<Domain>/<Kind>/<Component>        Review/Components/GateFailingCheckList
```

A title names the surface a user recognises, not the component tree.

- Domains: `Board`, `Documents`, `Inspector`, `Pipeline`, `Primitives`, `Review`, `Run telemetry`,
  `Settings`, `Setup`, `Shell`. Closed: a new one is a new top-level node in the sidebar.
- Kinds: `Components`, `Pages`, `Scenes`, `Docs`. Closed.
- The last segment is the file's own stem.

### One stories file per component

A variant is a story, told apart by its `args` and its export name. It is never a second file and
never a sibling sidebar node. Dashes in titles are banned, which makes this mechanical.

### One state vocabulary

`Default`, `Empty`, `Loading`, `Failed`, then names for states only that surface has. `Default` is
the populated, realistic case and comes first. `Failed` is any read or action that failed. It is
not `Error`, because `export const Error` shadows the global `Error` constructor for the whole
stories file.

### Every story renders something

A state that draws nothing is not a story: it belongs in a test, or in one line of the stories
file's header. A blank story looks the same as a broken one. `Empty` means an empty STATE (a list
with nothing in it, drawing its empty treatment), not an empty canvas.

### Width is a parameter

`parameters.width` picks the container: `panel` (420px, the inspector), `narrow` (280px, a card) or
`prose` (640px). Set it on anything that lives inside something. A component that changes with the
window width sets the `viewport` global instead (`globals: { viewport: { value: 'mobile2' } }`).

## Data

### Fixtures are shared

A fixture one component needs sits in its stories file. One that several need moves to
`frontend/app/app/stories/*.stories.mocks.ts`, typed with the contract type. Keep a base fixture
minimal: only the fields the contract requires, with the rest added per story.

`app/stories/fixtures.spec.ts` parses each shared fixture with the contract schema the backend
answers with, in the app's ordinary unit-test lane. The typecheck holds a fixture to its type; the
spec also holds it to what the type cannot say, such as an id pattern or a minimum. Add each new
shared fixture to its list.

### Seeding stores

State the app gets from the board snapshot is SEEDED (`app/stories/withStores.ts`):
`withSeed(() => { ... })` runs the seed in the story's own Nuxt app, before the component's setup.

- `withSnapshot(snapshot({...}))` / `seedSnapshot(...)` runs `applySnapshotToStores`, the same
  fan-out the workspace store's `hydrate` uses, so every store agrees with every other.
  `snapshot.stories.mocks.ts` builds one over the shared board in `board.stories.mocks.ts`.
- `seedViewer()` and `seedMember()` give the user a role, for the disabled states. The permissions
  are the backend's for that role.
- `seedResultView({ view, blockId, instanceId, stepIndex })` opens a result window. A run seeded
  whole is not fetched again; one marked `projected` makes `ResultWindowShell` read it.

Each story gets its own Nuxt app and its own Pinia. A seed in the meta's `decorators` runs under
every story, before the story's own seed, so a seed a story must not inherit goes on that story.

### Answering requests

Data a component LOADS is answered over HTTP (`app/stories/api.ts`). A story lists responses as
`parameters.api`, and `preview.ts` installs them on one msw worker before the story renders.

- `apiResponse(contract, { pathPrefix, pathParams, body })` builds the response from the route
  contract the app's client uses, and validates `body` against the contract's success schema. A
  workspace route takes `pathPrefix: storyWorkspacePrefix`, from `app/stories/workspace.ts`.
- `apiPending` never answers (a `Loading` story); `apiFailure` sends the backend's 500 envelope (an
  `Failed` story); `apiRefusal` sends a refusal with the status, code and message copied from the
  handler that refuses; `apiNoContent` answers a 204; `apiHandler` computes the response from the
  request and still validates it.
- `artifactBlobResponse`, `artifactBlobPending` and `artifactBlobFailure` answer a stored
  artifact's bytes, which have no contract.

A request no story answered is logged as an msw warning. `mockServiceWorker.js` is generated by
`msw init`, served from `.storybook/public`, and excluded from oxfmt.

### State between stories

`beforeEach` in `preview.ts` resets the module registry and clears every cookie (the app keeps
nine Pinia stores in cookies, so the advanced tier leaked into every later story). The msw handlers
are replaced in the first preview loader, because Storybook runs the loaders before `beforeEach`:
a story loader that fetches gets that story's answers. `withConfirmDialog` mounts the app's one `ConfirmDialog` beside the story and cancels a
request an earlier story left open. Local storage is NOT cleared: a story that writes a key there
must set it in every story of its file.

### Plays

A play ENDS by waiting for the state its story is named after: a `findBy*` for text, a role or a
test id that only that state draws. A play that only clicks passes when the click lands, even if
the state never renders.

A `play` that opens a menu, popover or modal queries `screen`, not `within(canvasElement)`: Nuxt
UI teleports overlays to `body`. A play that types into a debounced field needs no sleep:
`findBy*` retries for up to a second.

A story that changes the runtime config (`useRuntimeConfig().public`) puts the old value back when
it unmounts. The preset shares that object between stories, so a value one story sets stays for
every later story in the session.

## Checks

| What                                                                                    | Where it runs                   |
| --------------------------------------------------------------------------------------- | ------------------------------- |
| The stories typecheck                                                                   | the app's `typecheck`, every PR |
| `fixtures.spec.ts`                                                                      | the app's unit tests, every PR  |
| `node scripts/check-story-titles.mjs` (titles, one file per component, `Default` first) | CI's guard steps, every PR      |
| `test:stories`: every story renders in headless Chromium, with an axe check             | nightly, and on request         |

`test:stories` takes about 10 minutes for the whole tree, so no PR waits on it.
`--browser.isolate=false` cut that to about 2 minutes, and was rejected: with the files shuffled,
2 of 4 runs timed out on stories that pass alone, and no story failed twice. Those runs used
Vitest's default worker count, before the cap below, so contention may explain the timeouts; the
trade-off is worth measuring again at the cap. Vitest 5 replaces `browser.isolate` with the
top-level `isolate` option.

The config caps the lane at 3 workers. Without a cap, Vitest's run mode uses every core but one
(at most 12 in browser mode), so CI's 4-vCPU `ubuntu-latest` runner gets 3, and a 14-core Mac gets 12. Each worker is a Chromium page that loads its story files from the one Vite server and renders
them. On the 14-core Mac a full run held the whole CPU. The cap gives a local run CI's worker count.
One run each of the same 40 files on that Mac, all passing:

| Workers          | Wall time | Peak load | Peak RSS (Chromium + node) |
| ---------------- | --------- | --------- | -------------------------- |
| 12 (the default) | 46s       | 10.7      | about 16.7 GB              |
| 7 (`'50%'`)      | 41s       | 9.2       | about 15.1 GB              |
| 4                | 42s       | 6.8       | 14.6 GB                    |
| 2                | 50s       | 8.0       | 10.5 GB                    |

More than 4 workers added load and no speed; 3 was not measured, and is chosen to match CI. The
node side (the Vite server and the runner) holds
about 3 GB at any worker count, and only the Chromium part shrinks with fewer workers. The node
column also counts about 1.8 GB of unrelated node processes, and the RSS sum counts shared Chromium
memory more than once, so compare the rows, not the totals. Each start load was about 4.5, and the
1-minute average lags on a short run, so the load column is approximate. Pass `--maxWorkers=2` on
the command line to trade about 20% more time for less memory: at most about 4 GB, an upper bound,
since the RSS difference between two rows still counts shared memory more than once.

The cap reduces the lane's own contention. It does not fix the first story of a file timing out
under load: that story also pays the file's cold setup inside the 15s test timeout, whatever the
worker count.

To re-derive the cap on another machine, run Vitest's `doctor`. It measures half the configured
worker count and halves again, so give it the uncapped count:

```sh
pnpm --filter @cat-factory/storybook exec vitest doctor --config vitest.stories.config.ts --maxWorkers=12
```

`parameters.a11y.test` is `todo`: axe violations are REPORTED, not failed on, because `main` has
real ones (the `text-dimmed` token at 2.63:1, an unlabelled `SecretInput`). Change it to `error`
when that baseline is clean.
