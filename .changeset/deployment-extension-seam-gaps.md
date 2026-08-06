---
'@cat-factory/prompt-fragments': major
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Close the deployment extension-seam gaps a consumer build hit: every app-owned registry is now
reachable from the documented boot entry point, and the prompt-fragment pool is injected rather than
a module global.

An org package outside this repo built a proprietary reusable operation against the PUBLISHED
`@cat-factory/*` packages and reported nine gaps. Each seam it hit typechecks, boots, passes CI, and
is either unreachable from the supported entry point or silently inert once reached. None showed up
in our own tests because the worked example lives INSIDE this repo, where the composition root calls
`buildNodeContainer` directly and every package resolves to one copy on disk.

**Breaking, `@cat-factory/prompt-fragments`.** `registerPromptFragment(s)`,
`clearRegisteredPromptFragments`, `universalFragments`, `registerTaskTypeDefaultFragments`,
`clearRegisteredTaskTypeDefaultFragments` and `defaultFragmentIdsForTaskType` are REMOVED. They were
two module globals, correct only while every reader resolved the same physical copy of the package;
a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto a
newer patch got two copies, the registration landed in one, the server read the other, and every
task of the operation was seeded with fragment ids that folded nothing. Replaced by the app-owned
`PromptFragmentRegistry` (kernel), injected by reference:
`promptFragmentRegistryWithBuiltins()` news one carrying the shipped catalog, and it is an option on
`start()` / `startLocal()` / the Worker overrides. `getFragment` remains, narrowed to the shipped
catalog. One behaviour change rides along: `registerTaskTypeDefaults` REPLACES a built-in per-type
set instead of silently unioning with it, so a deployment can now remove a shipped default; spread
`DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` to keep both.

**Also breaking (internal surfaces, pre-1.0, no shims).** `validateRegistrations` /
`collectRegistrationProblems` take their registries as ONE `registries` object (a facade passes its
container) instead of seven hand-listed optional fields; that hand-list is why the local mothership
boot validated five registries while its own comment claimed parity with `start()`, so a custom task
type naming an unregistered pipeline booted clean on a laptop and failed on the Postgres path.
`FragmentLibraryService` takes a `promptFragmentSource` and no longer falls back to the module pool.
`TaskTypeCreationDefaults.fragmentIdsFor` is async.

**What is new rather than moved.** `start()` and `startLocal()` gain `pipelineRegistry`,
`gateRegistry`, `judgeRegistry`, `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry`;
the seam drift guard now asserts against those ENTRY POINTS rather than only the container builder
behind them, which is how `pipelineRegistry` sat on `NodeContainerOptions` (documented, guarded,
green) while no boot path forwarded it and local deployments had no escape hatch at all. A registered
task type may declare `conditionalFragmentIds`, standing context selected by a `showWhen` condition
over the answers a case supplied, evaluated once at creation by the same evaluator the form's own
field visibility uses. A code-registered fragment carrying a `documentRef` now FAILS boot rather than
being carried through the catalog, rendered as a live source in the library UI, and ignored at run
time. An unresolvable standing-context id is reported on the run that dropped it instead of only as
one boot warning that cannot be told apart from a typo. And a mothership-mode node reads the pool
from the mothership over `GET /internal/prompt-fragments`, throwing rather than answering with an
empty pool.
