# ADR 0040: Deployment extension seams are reachable from the supported entry point

- **Status:** Accepted (implemented)
- **Date:** 2026-08-06
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/prompt-fragments`, `@cat-factory/agents`, `@cat-factory/orchestration`, all three
  runtime facades) + the SPA (`@cat-factory/app`) + docs/CI guards

Supersedes the `deployment-extension-seam-gaps` initiative tracker, whose committed scope is
complete. Records the shape of the seams a deployment extends the platform through, which
[ADR 0028](./0028-registry-di.md) established and [ADR 0018](./0018-agent-kind-registry-di.md)
piloted; the feature whose consumer found these is
[reusable operations](../reusable-operations.md).

## Context

An org package outside this repo built a proprietary reusable operation against the PUBLISHED
`@cat-factory/*` packages and could not use several of the seams that exist for exactly that.
Every finding was a seam that typechecks, boots, passes CI, and is either unreachable from the
supported entry point or silently inert once reached. None of it showed up in our own tests,
because the worked example lives INSIDE this repo, where the composition root can call
`buildNodeContainer` directly and every package resolves to one copy on disk.

Two failure shapes recurred, and both are the reason this ADR exists rather than nine bug fixes:

- **A seam guarded at the wrong boundary.** `registry-seams.spec.ts` exists to stop a registry
  landing unthreaded, and `pipelineRegistry` passed it while being unreachable through `start()`
  and `startLocal()`, because the guard asserted against the container BUILDER's options rather
  than the boot ENTRY POINT a deployment calls. `startLocal` deliberately withholds
  `buildContainer`, so on that facade there was no way in at all.
- **Deployment-registered state that a RUN resolves, skipping the org-state rule.** The
  best-practice fragment pool was a module-level `Map` in a package no facade re-exports, so a
  consumer floating its version got two physical copies: the registration landed in one, the server
  read the other, and every task was seeded with ids that folded nothing. The only signal was one
  boot warning, which is also what a typo produces.

A third shape showed up once: a field ACCEPTED, carried through the merge, put on the wire and
rendered by the library UI with a "live from github" badge, which the resolver then refuses because
every code-registered fragment lands on the `builtin` tier. Accepted everywhere it is visible,
honoured nowhere, and the surface most confident about it was the one telling a human the body was
live.

## Decision

**The boot entry points expose every app-owned seam, and the guard grades the DOOR.** The seam
classification now covers `start()`'s and `startLocal()`'s option types, with a route class for the
facade-internal sources (`foundationalBuiltinSource` / `binaryGeneratorSource`, set only by the
local mothership path) so the classification stays total and records the intent for a seam whose
absence is deliberate. The missing options followed from the red typecheck rather than from a list.

**`validateRegistrations` takes the CONTAINER, not a hand-list.** Its argument used to be seven
optional registries named at each call site, which is what put the local mothership boot two
registries behind the others: it passed five, its own comment claimed parity with `start()`, and a
custom task type naming an unregistered pipeline booted clean there while failing on the Postgres
path. A hand-list has no failure mode other than being incomplete, and nothing can tell that it is.
A registry added to the validator now reaches all three facades with no call-site edit.

**The fragment pool is an app-owned `PromptFragmentRegistry` plus a `PromptFragmentSource`**, the
`FoundationalServiceRegistry` + `HttpFoundationalBuiltinSource` pattern applied to the same problem:
a code-registered catalog a run resolves. `registerTaskTypeDefaultFragments` (the second module
global in that package, with the identical hazard) moved with it. The source read THROWS rather than
answering empty, because an unreachable mothership and a deployment that registered no standards are
the same value and opposite facts.

**A `builtin`-tier `documentRef` is refused at boot**, naming the two paths that work. It is not
honoured, which is what the report asked for: `resolveDocumentBody` needs a connection WORKSPACE to
fetch through, and a deployment-wide registration has none, so resolving would fetch text into every
workspace's prompts on one tenant's stored credential and key ONE document under N per-workspace
cache groups. That is the fan-out the existing guard already refuses for the account tier.

**An unresolvable standing-context id is reported on the RUN**, through kernel's `Logger` wired into
`FragmentLibraryService`, rather than being made a boot error. The account tier is the only supported
path to an org-wide living document, so a code registration naming a tenant-tier id is the shape we
tell deployments to use; the defect was the missing report, not the severity.

**An operation's standing context may depend on the answers just collected**
(`conditionalFragmentIds`), reusing `DescriptorFieldShowWhen` verbatim and ONE evaluator extracted
from `isDescriptorFieldVisible`, which carries the rule a re-implementation gets wrong (an absent
value reads as `false` against a boolean condition).

**A descriptor form groups under optional `section` captions.** Consecutive fields sharing a caption
render as one run, visibility applies before the runs are cut (so a section whose every field is
hidden renders no caption), and declaration order is never rearranged. A section a filled form can be
made to caption TWICE fails boot, because the two available renderings are a caption printed twice and
a field moved away from where its author wrote it. That refusal judges REACHABILITY rather than
contiguity in the declared list, for the same reason the runs are cut after visibility is applied: a
branching form interleaves its branches on purpose, and refusing it would fail boot over a form no
user can break. Every surface declaring such a form is checked, the gate config form included.

**The reference docs ship inside the published tarballs**, with a CI guard
(`check-shipped-doc-links.mjs`) failing any markdown file in a tarball whose relative link escapes
its package root.

## Rationale

- **A guard belongs at the boundary a consumer crosses.** The builder-options assertion was true and
  useless: `pipelineRegistry` was a key of `NodeContainerOptions` with a doc comment describing the
  deployment use case, and no supported call could reach it. This is the general lesson of the whole
  report, and the reason the guard now grades entry points.
- **A registry a RUN resolves owes the mothership question**, because a node one build behind the
  mothership is the NORMAL state of running a pair. `pipelineRegistry` took the documented boot WARN
  rather than a remote source, and the deciding difference from the two sources that DO read remotely
  is that a pipeline skew fails LOUDLY: a definition only the mothership has is refused at
  `adoptForRun`, and one only the node has is adopted INTO a row through the remote repository. The
  other half is that `seedPipelines`/`retiredPipelines` are synchronous and read on every board list,
  so a remote source would put a network hop on a hot path to remove a divergence that already fails
  safely. The reasoning is recorded at the warn site.
- **`defaultFragmentIdsFor` became async on purpose.** The per-task-type default SET is org state a
  creation resolves, so it rides the source rather than the registry. The throw propagates through
  `BoardService.addTask`: a task seeded with a silently short standing context is the failure the
  seam exists to prevent, and creation is a user action that can be retried.
- **Boot ERRORS on what is fully knowable from a registration and WARNS only where it structurally
  cannot see the answer.** That single bar decided every severity here, including the two that look
  inconsistent side by side: a `builtin` `documentRef` (error: no forward state resolves it) against
  an unresolvable fragment id (warn: an account-tier row merges per workspace at run time and is
  invisible at boot).
- **A grouping caption is presentation, and it still fails boot when it cannot be rendered
  honestly.** Refusing at boot keeps the renderer free of a repair nobody asked for: it never
  reorders a form, so what a deployment declared is what a user sees. The counterweight is that a
  refusal at error severity is itself a failure mode: it must be judged against what a form can
  actually be made to PRINT, or the check breaks more deployments than the fault it names.
- **A shared vocabulary spreads its rendering surfaces faster than its checks.** `section` reached the
  gate config form for free, through the shared field spread and the shared component, while the boot
  check reached only the two surfaces whose declarations are descriptor TYPES. Adding an attribute to
  the spread is therefore not the whole change: every surface that renders the vocabulary owes the
  check, and the checker's subject is a named union so the next one has to be added deliberately.

## Consequences

- **`registerPromptFragment` and `registerTaskTypeDefaultFragments` are gone as module globals.** A
  deployment registers on the injected `promptFragmentRegistry` passed to `start()` / `startLocal()`,
  and `registerTaskTypeDefaults` REPLACES a built-in per-type set rather than unioning with it: the
  old seam unioned silently, so a deployment could not remove a shipped default however it wrote the
  call. Spreading `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` into its own list is how a deployment now
  says it wants both, which says so in the code. Internal surface, so no shim was owed.
- **A registry whose platform built-ins install through the public seam must be defaulted in the
  facade's CONTAINER BUILDER, not only at its boot entry point.** On the Worker, `createWorker`
  resolves the registries once and threads them in, but a cron sweep, a Workflow step and a Durable
  Object each call `buildContainer(env)` with no overrides, so an entry-point-only default left
  exactly the re-driven runs nobody watches folding no standards. `resolveWorkerRegistries` is where
  this is done and `test/registry-builtin-defaults.test.ts` pins it.
- **`section` is additive on `/api/v1`** (`GET /api/v1/task-types`, surface version `1.20.0`): a
  client that ignores it fills the same bag as before.
- **A deployment-scoped document source is DECLINED, not scheduled.** It needs an owner-scope member
  on `FragmentOwnerKind`, a credential home and a mothership routing decision, and nothing asks for
  it: the account tier already serves an org-wide living document, and the boot error now names that
  path at the moment a deployment reaches for the wrong one. Re-open it when a deployment has an
  org-wide document it cannot nominate ANY workspace's connection for.
- **Two things were checked and are genuinely fine**, recorded so nobody re-investigates. A
  fragment's `appliesTo` never gates a run (the run path folds a block's `fragmentIds` directly; it
  is read only by the relevance selector on the management surface), and an authored `brief` is never
  re-checked (`resolveFragmentBrief` returns `{ kind: 'authored' }` before any ratio or length test),
  so authoring one per fragment is free and removes the condensation call.
- **The next report of this kind is still likely**, and the two shapes above are how to read it: ask
  which boundary a guard grades, and whether the state a deployment registers is state a RUN
  resolves.
