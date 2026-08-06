# Initiative: close the deployment extension-seam gaps a consumer build hit

**Status:** slices 1-9 landed (every High + Medium item); S7 (Low) and S3b (its own tracker) open · **Owner:** core · **Started:** 2026-08-05

> Provenance: an org package outside this repo built a proprietary reusable operation ("expose
> public API") against the PUBLISHED `@cat-factory/*` packages and reported nine gaps. This
> tracker is the revised version of that report: every finding was re-verified against HEAD, which
> changed two of them (one had already been fixed, one had the wrong remedy attached). The
> consumer measured `@cat-factory/kernel@0.245.0` / `contracts@0.247.0` / `agents@0.114.0` /
> `orchestration@0.214.0` / `prompt-fragments@0.15.73` / `node-server@0.177.0` /
> `local-server@0.110.1` / `app@0.230.0`.
>
> Companions: [`reusable-operations.md`](./reusable-operations.md) (the feature whose consumer
> found these) and its reference doc
> [`backend/docs/reusable-operations.md`](../../backend/docs/reusable-operations.md);
> [`fragment-definitions-reseed.md`](./fragment-definitions-reseed.md) (item S3 must be decided
> before that lands); [`mothership-mode.md`](./mothership-mode.md) (the org-state routing rule
> items S1 and S2 both owe); [`descriptor-driven-infra-forms.md`](./descriptor-driven-infra-forms.md)
> (the descriptor-form vocabulary item S7 extends).

## Goal & rationale

The extension seams work, and a real deployment still could not use several of them. That is the
value of this report: every item below is a seam that typechecks, boots, passes CI, and is
either unreachable from the supported entry point or silently inert once reached. None of it
showed up in our own tests because the worked example lives INSIDE this repo, where the
composition root can call `buildNodeContainer` directly and every package resolves to one copy on
disk.

Two failure shapes recur, and both are worth naming once because they will produce the next
report too:

- **A seam is guarded at the wrong boundary.** `registry-seams.spec.ts` exists precisely to stop a
  registry landing unthreaded, and `pipelineRegistry` passed it while being unreachable through
  `start()` and `startLocal()`, because the guard asserts against the container BUILDER options
  rather than the boot ENTRY POINT a deployment actually calls.
- **Deployment-registered state resolved by a RUN skipped the org-state rule.** Both the fragment
  pool and the pipeline registry are things a deployment registers in CODE that a run resolves, so
  both owe the `/internal/*` read that `foundationalBuiltinSource` and `binaryGeneratorSource`
  already have. "Add the option" is half of each design.

## Summary

| #         | Gap                                                                                       | Severity | Their ask                        | Disposition                                 |
| --------- | ----------------------------------------------------------------------------------------- | -------- | -------------------------------- | ------------------------------------------- |
| [S1](#s1) | The boot entry points expose an arbitrary SUBSET of the app-owned seams (G3 + G4)         | High     | forward `pipelineRegistry`       | ✅ Landed: options + entry-point guard      |
| [S2](#s2) | The fragment pool is a module global in a package no facade re-exports (G2)               | High     | add a registry option            | ✅ Landed: registry + `/internal` source    |
| [S3](#s3) | A `builtin`-tier `documentRef` is carried, rendered as live, and ignored at run time (G1) | High     | honour it at `builtin`           | ✅ Landed: boot ERROR; remedy still refused |
| [S4](#s4) | The canonical operations doc and worked example are unreachable from an install (G7)      | Medium   | publish them                     | ✅ Landed: absolute URLs + a CI guard       |
| [S5](#s5) | An unresolvable standing-context id is dropped silently on EVERY run (G6)                 | Medium   | split the descriptor field       | ✅ Landed: run-level report, no field split |
| [S6](#s6) | An operation's standing context cannot depend on the answers just collected (G9)          | Medium   | conditional `defaultFragmentIds` | ✅ Landed: `conditionalFragmentIds`         |
| [S7](#s7) | Descriptor forms have no grouping, so a 13-field operation reads as one column (G8)       | Low      | `section?: string`               | ⬜ Open (Low)                               |
| [S8](#s8) | `CustomTaskType` and the pipeline ids are unreachable from either facade (G5)             | -        | re-export from the facades       | **Stale**: landed in #1654 (kernel 0.246.0) |

## S1. The boot entry points expose an arbitrary subset of the app-owned seams {#s1}

**What is wrong.** `registry-seams.spec.ts` classifies ten deployment-facing registries as
`option`. `start()` (`backend/runtimes/node/src/server.ts:244`) exposes five of them:
`agentKindRegistry`, `initiativePresetRegistry`, `taskTypeRegistry`,
`foundationalServiceRegistry`, `binaryGeneratorRegistry`. Missing: `pipelineRegistry`,
`gateRegistry`, `judgeRegistry`, `stepResolverRegistry`, `vcsRegistry`. `startLocal()`
(`backend/runtimes/local/src/server.ts:72`) exposes the same five plus `backendRegistries`, and
deliberately withholds `buildContainer` (the reasoning is at `server.ts:68`), so on the local
facade there is no way in at all: Node deployments have the `buildContainer` escape hatch, local
deployments have nothing.

Three things make this worse than a missing option:

- **The guard covers the builder, not the door.** `registry-seams.spec.ts:86` asserts every
  `option` seam is a key of `NodeContainerOptions`. `pipelineRegistry` is (`container-options.ts:393`,
  with a doc comment describing the deployment use case), so the guard is green while the seam is
  unreachable through the only entry points `startLocal` users have.
- **The reference doc prescribes a call that does not compile.**
  `backend/docs/reusable-operations.md:322` prints
  `start({ agentKindRegistry, pipelineRegistry, taskTypeRegistry /* …the rest */ })`.
- **The same registration errors on one path and boots silently on another.**
  `checkCustomTaskTypes` raises `task_type_unknown_pipeline` at ERROR severity for an unresolvable
  `defaultPipelineId`, so a task type naming an unregisterable pipeline refuses to boot on the
  Postgres path. On the local MOTHERSHIP path (`backend/runtimes/local/src/server.ts:423`)
  `validateRegistrationsOnce` is called without `taskTypeRegistry` or `pipelineRegistry`, so the
  same registration boots clean and the type silently falls back to the positional default at run
  time. A non-namespaced id, a duplicate field key, an optionless picker and a `showWhen` on an
  undeclared field boot silently there too. The call site's own comment claims parity with
  `start()`.

**Shape to land.**

1. Extend the seam guard to the BOOT entry points: `start()`'s and `startLocal()`'s option types,
   with a route class for the facade-internal sources (`foundationalBuiltinSource` /
   `binaryGeneratorSource`, set only by the local mothership path) so the classification stays
   total and records the intent for the four seams whose absence may be deliberate.
2. Add the missing options, following from the red typecheck rather than from this list.
3. Make `validateRegistrations`'s argument DERIVE from the container rather than being a
   hand-listed set of seven optional registries. That hand-list is the shared cause of the
   mothership omission, and passing two more registries at one call site fixes one instance of it.
4. Decide `pipelineRegistry` in mothership mode in the same change (see the gotcha below). A run
   ADOPTS a catalog entry through `pipelineAdoption`, so a node's own registry is a second copy by
   construction. Either a `PipelineSource` `/internal/*` read, or the boot warn
   `binaryGeneratorRegistry` already documents at `local/src/server.ts:111`.

## S2. The fragment pool is a module global in a package no facade re-exports {#s2}

**What is wrong.** `backend/packages/prompt-fragments/src/index.ts:60` keeps a module-level `Map`
that `registerPromptFragment` mutates, and the readers each resolve their OWN copy of the package:
`FragmentLibraryService` (agents), `validateRegistrations` (orchestration,
`validateRegistrations.ts:32`), the server's fragment controller. Neither facade re-exports the
registration functions, so a deployment must depend on `@cat-factory/prompt-fragments` directly,
and the published graph pins it EXACTLY (a `workspace:*` dependency publishes as the exact
version). A consumer floating the range onto a newer patch therefore gets two physical copies:
the registration lands in one, the server reads the other, and every task of the operation is
seeded with ids that fold nothing into the prompt. The only signal is one boot warning
(`task_type_unknown_fragment`), which is also the warning a typo produces (see S5).

Two things the report missed:

- **`registerTaskTypeDefaultFragments`** (`prompt-fragments/src/task-type-defaults.ts`, read
  through `defaultFragmentIdsForTaskType` in `orchestration/.../taskTypeCreationDefaults.ts`) is a
  SECOND module global in the same package with the identical hazard. It moves in the same change.
- **The TYPE is already reachable**: kernel re-exports `PromptFragment`
  (`kernel/src/domain/types.ts:55`), so the only reason to depend on the package at all is the
  mutator, which is exactly the thing that should move.

**Shape to land.** `PromptFragmentRegistry`, app-owned, injected by reference, plus a
`PromptFragmentSource` for the mothership read. Pilot to copy end to end:
`FoundationalServiceRegistry` + `HttpFoundationalBuiltinSource`, which solved the same problem for
the same reason (a code-registered catalog a run resolves). Adding both to `SEAM_ROUTES` makes the
facades fail to compile until they are threaded. The source read THROWS rather than answering
empty: an unreachable mothership and a deployment that registered no standards are the same value
and opposite facts.

This is an internal-surface break, so it needs no shim or dual-read path, only a changeset that
names it.

**Gotcha this one surfaced, for the registries still to migrate.** A registry whose platform
built-ins install through the public seam has to be defaulted in the facade's CONTAINER BUILDER,
not only at its boot entry point. On the Worker, `createWorker` resolves the registries once and
threads them in as overrides, but a cron sweep, a Workflow step and a Durable Object each call
`buildContainer(env)` with no overrides at all, so an entry-point-only default left exactly the
re-driven runs nobody watches folding no standards. Empty is not an error anywhere along that
path: the run simply completes having read a pool the deployment thinks it registered on.
`resolveWorkerRegistries` is where the gate registry already does this, and
`test/registry-builtin-defaults.test.ts` pins it for both.

## S3. A `builtin`-tier `documentRef` is carried, rendered as live, and ignored at run time {#s3}

**What is wrong.** `registerPromptFragment` accepts a whole `PromptFragment`, `documentRef`
included; `builtinToEntry` faithfully carries it into the resolved entry with
`docViaWorkspaceId: null` (`agents/src/fragmentLibrary/fragment-catalog.ts:50`); and
`resolveDocumentBody` then refuses it: `if (!ref || !this.documentResolver || entry.tier ===
'builtin') return entry.body` (`FragmentLibraryService.ts:568`). Every deployment-registered
fragment lands on that tier, so a code-registered `documentRef` is accepted, preserved through the
merge, and silently ignored.

It is worse than silent in two places the report did not check:

- `entryToFragment` puts `documentRef` on the wire (`fragment-catalog.ts:153`) and
  `FragmentLibraryManager.vue:666` renders a `fragments.catalog.live` badge NAMING the source, so
  the library UI advertises "live from github" over a frozen body.
- `taskTypeCreationDefaults.ts` promises in its own doc comment that "bodies live-resolve per run,
  so editing a guideline reaches tasks created before the edit". False at the only tier a
  deployment can register into.

**Why their preferred remedy is refused.** The report asks for `documentRef` to be honoured at
`builtin` tier, with a registration carrying something like `docViaWorkspaceId: 'first-available'`.
That resolves a deployment-wide document through an arbitrary tenant's stored credential, so one
workspace's connection fetches text that lands in every other workspace's prompts, and keys the
body cache under a workspace that can be deleted. The existing guard is not an oversight: with no
recorded connection workspace, falling through would key ONE deployment-wide document under N
per-workspace cache groups, which is the exact fan-out `resolveDocumentBody`'s own comment refuses
for the account tier.

`seedDocumentFragments` on `start()` is not a substitute either:
`createFromDocument(ownerKind, ownerId, input, fetchViaWorkspaceId)` requires a nominated
connection workspace that a code seed cannot know, so it would either invent the same wrong rule or
seed per-workspace rows that each need their own connection.

**Shape to land now.** Refuse the dead seam: a `builtin`-tier registration carrying `documentRef`
is an ERROR in `collectRegistrationProblems`, naming the two supported paths. That converts a
silent lie into a build failure, which is the whole point of validating code registrations at boot.

**The real feature, separately.** A living deployment-wide document needs a DEPLOYMENT-scoped
document source: `FragmentOwnerKind` has no deployment member and every `documentResolver.fetch`
takes a workspace id, so it is an owner-scope change plus a credential home plus a mothership
routing decision. That earns its own tracker, not a field on a registration.

## S4. The canonical operations doc and worked example are unreachable from an install {#s4}

**What is wrong.** `frontend/app/app/docs/consumer-extensions.md:216` points at
`../../../../backend/docs/reusable-operations.md`, which escapes the published package root
(`@cat-factory/app` ships `files: ["app", "i18n", "nuxt.config.ts"]`), and the `org:introduce-api`
worked example it cites beside it lives in `@cat-factory/example-custom-agent`, which is
`private: true`. So the best document about the feature, and the example that answers most of what
this report asked, are both invisible to a consumer install. Two of the nine findings are partly a
consequence of that.

**Shape to land.** Ship the reference doc inside a published tarball (own it in the package that
owns the seam, or inline the material and drop the dangling links), publish the example module or
stop citing it, and add a CI check that a doc shipped in a tarball has no relative link escaping
its package root. Without the check this recurs on the next doc.

## S5. An unresolvable standing-context id is dropped silently on every run {#s5}

**What is wrong.** `resolveBodiesForRun` skips an id the catalog does not resolve with
`if (!entry) continue` (`FragmentLibraryService.ts:525`), and the service takes no `Logger` at all.
So an operation meant to fold three standards folds two, forever, on every run, and the only trace
anywhere is one boot WARNING that cannot distinguish a typo from a legitimate tenant-tier id.

**Why the field split is refused.** The report asks for `defaultFragmentIds` (strict, error) beside
a new `tenantFragmentIds` (unchecked). That encodes a validation hint in the data model, adds a
second field a registration can get wrong, and breaks the moment the same operation is registered
on a deployment where that standard IS code-registered. The boot severity is defensible for the
reason the source states, and the report's own S3 workaround depends on account-tier references
staying legal.

**Shape to land.** Report the omission where it happens. Wire kernel's `Logger` into
`FragmentLibraryService` (optional, normalised once to `noopLogger`) and record the dropped ids on
the RUN, per "every cap records what it dropped". Then a typo costs one run to find instead of
never, and the S2 dual-install failure surfaces per run rather than as one boot line.

## S6. An operation's standing context cannot depend on the answers just collected {#s6}

**What is wrong.** `defaultFragmentIds` is a static list unioned at creation, while the per-case
answers are collected in the same form, so an operation cannot say "when `protocol` is `graphql`,
also seed the GraphQL standard". The deployment pays for every branch on every run, or folds the
conditional guidance into one long standard and loses the per-standard citation the reviewers'
adherence report relies on.

This is coherent with the model rather than a stretch of it: ids freeze at creation, the answers
freeze at creation, and "a task owns its selection, never re-unioned at run time" is already the
rule, so a creation-time reduction is well defined.

**Shape to land.** Reuse `DescriptorFieldShowWhen` verbatim for the condition instead of inventing
a `{ key, equals }` pair, and evaluate it through ONE evaluator extracted from
`isDescriptorFieldVisible`, which carries the non-obvious rule that an absent value reads as
`false` against a boolean condition. Traps: a `when.key` naming an undeclared field must fail boot
(the same error class as `task_type_field_unknown_condition`), a condition on a field hidden by its
own `showWhen` reduces to false to match what `sanitizeDescriptorFields` freezes, and the reduction
lives beside `fragmentIdsFor` in `taskTypeCreationDefaults` so the union order stays one rule.

## S7. Descriptor forms have no grouping {#s7}

**What is wrong.** `DescriptorFields.vue` renders `fields` as one flat column in declaration order
and `contracts/src/form-fields.ts` has no grouping attribute. The reported operation collects 13
fields, every one of which changes what the agents do.

**Shape to land.** An optional `section?: string` on `descriptorFieldEntries` (the shared spread,
so both surfaces gain it at once and cannot drift), rendered as a caption above the first field
carrying it. Traps: a section whose every field is hidden by `showWhen` must render no caption (the
same class of empty-control fault the boot checks already cover), section order is
first-occurrence-in-declaration-order, interleaved sections are either refused at boot or
normalised deliberately, and this is presentation only: no validation change, nothing frozen,
no change to the prompt fold.

## S8. Already landed {#s8}

The report asks for `CustomTaskType`, `TaskTypeFieldDescriptor`, `TaskTypePresentation`,
`PromptFragment` and the `*_PIPELINE_ID` constants to be re-exported. Kernel already re-exports the
types (`kernel/src/domain/types.ts:26`, `:55`) and every pipeline id (`kernel/src/index.ts:177`),
landed in #1654 on 2026-08-04 and shipped in `kernel@0.246.0`, one version after the 0.245.0 the
report measured. Kernel is a published, non-private package that both facades already re-export
registry classes from, so it is the supported vocabulary import and a facade re-export would be
convenience only. No action beyond one line in the reference doc naming kernel as the import.

## Per-slice status checklist

| #   | Slice                                                                                                                                                                  | Scope  | Depends on | Status  | PR    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------- | ----- |
| 0   | This tracker                                                                                                                                                           | DOCS   | -          | ✅ done |       |
| 1   | **S4**: publish the reference doc + the example (or drop the citation); CI link check for docs shipped in a tarball; correct the `start({ pipelineRegistry })` snippet | DOCS   | -          | ✅ done | #1755 |
| 2   | **S1a**: extend the seam guard to `start()` / `startLocal()` option types; route class for the facade-internal sources                                                 | SYSTEM | -          | ✅ done | #1755 |
| 3   | **S1b**: add the missing options the guard now demands; derive `validateRegistrations`' argument from the container; mothership call site becomes total                | SYSTEM | 2          | ✅ done | #1755 |
| 4   | **S1c**: `pipelineRegistry` in mothership mode: `PipelineSource` read or the documented boot warn, decided and asserted                                                | SYSTEM | 3          | ✅ done | #1755 |
| 5   | **S3a**: refuse a `builtin`-tier `documentRef` at boot, naming the supported paths; assert it                                                                          | SYSTEM | -          | ✅ done | #1755 |
| 6   | **S2**: `PromptFragmentRegistry` + `PromptFragmentSource`; absorb `registerTaskTypeDefaultFragments`; `SEAM_ROUTES` entries; conformance both runtimes                 | SYSTEM | 2          | ✅ done | #1755 |
| 7   | **S5**: `Logger` into `FragmentLibraryService`; the run records the standing-context ids it dropped                                                                    | SYSTEM | -          | ✅ done | #1755 |
| 8   | **S6**: conditional `defaultFragmentIds` over `DescriptorFieldShowWhen`; one shared evaluator; boot validation                                                         | SYSTEM | -          | ✅ done | #1755 |
| 9   | **S7**: `section?: string` + the caption; hidden-section and ordering rules                                                                                            | BOTH   | -          | ⬜ todo |       |
| 10  | **S3b**: deployment-scoped document source (its own tracker, opened by this slice or explicitly declined)                                                              | SYSTEM | 5          | ⬜ todo |       |

Slices 1-8 landed together rather than one PR each. They turned out to be one change: the seam
guard (2) fails until the options exist (3), the options are what the fragment registry (6) is
threaded through, and the registry is what S3a (5) validates and what S5 (7) reports against. What
survived as separable is S7, which is presentation-only and touches neither, and S3b, which is a
feature rather than a fix.

## What landed, and where it differs from the plan above

- **S1c chose the boot WARN, not a `PipelineSource`.** The tracker offered either. The deciding
  difference from the two sources that DO read remotely: when the two builds disagree about a
  pipeline the failure is LOUD. A definition only the mothership has is offered by the board and
  then refused at `adoptForRun` (no stored row, no catalog entry, null); a definition only the node
  has is adopted INTO a row through the remote repository, so it lands on the mothership. Neither
  is the silent omission an empty foundational tier produces. The other half is that
  `seedPipelines`/`retiredPipelines` are synchronous and read on every board list, so a remote
  source would put an awaited network hop on a hot path to remove a divergence that already fails
  safely. The reasoning is recorded at the warn site; if a future change makes the skew silent,
  that comment is the thing to re-read.
- **S2 took `defaultFragmentIdsFor` async.** The per-task-type default SET is org state a creation
  resolves, so it rides the source rather than the registry, which made
  `TaskTypeCreationDefaults.fragmentIdsFor` async and `BoardService.addTask` await it. The throw
  propagates on that path deliberately: a task seeded with a silently short standing context is the
  failure the seam exists to prevent, and creation is a user action that can be retried.
- **S2 changed one behaviour rather than preserving it.** `registerTaskTypeDefaults` REPLACES a
  built-in per-type set instead of unioning with it. The module-global seam unioned silently, which
  meant a deployment could not remove a shipped default however it wrote the call. A deployment
  that wants both now spreads `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` into its own list, which says
  so in the code. Internal surface, so no shim; named in the changeset.
- **S4 was wider than the one link.** The new guard found 46 escaping links across 10 shipped docs
  (`@cat-factory/cli`, `eks`, `prompt-fragments`, `provider-bedrock`, `provider-s3`,
  `executor-harness`, `app`, `sdk/mcp`, `sdk/typescript`), not just the
  `consumer-extensions.md` → `reusable-operations.md` one the report hit. All are now absolute
  repo URLs. The example package stays `private: true` and is CITED by absolute URL rather than
  published: the repo is public, so the link is reachable from an install, and publishing a
  `backend/internal/*` package would cut against the repository layout for no gain the URL does not
  already give.
- **S3b is DECLINED for now, not opened.** A deployment-scoped document source needs an owner-scope
  member on `FragmentOwnerKind`, a credential home, and a mothership routing decision, and nothing
  currently asks for it: the account tier already serves an org-wide living document, and S3a's
  boot error now names that path at the moment a deployment reaches for the wrong one. Re-open it
  when a deployment has an org-wide document it cannot nominate ANY workspace's connection for.

## Conventions & gotchas

- **Land S4 first.** It is docs-only, carries no code risk, and it is upstream of two other
  findings: the consumer could not read the reference doc, so part of this report is a
  reconstruction of what that doc already says.
- **The mothership question is not optional for S1 or S2.** Both add a registry whose contents a
  RUN resolves, which is the case the org-state rule exists for: a node one build behind the
  mothership is the NORMAL state of running a pair, so a node consulting its own copy folds
  different standards than the pipeline builder offered, or adopts a pipeline the mothership does
  not have. The two existing sources are the model, and the read throws rather than answering
  empty.
- **S3 must be decided before [`fragment-definitions-reseed.md`](./fragment-definitions-reseed.md)
  lands.** That initiative makes `mergeCatalog` report `tier: 'builtin'` for PERSISTED rows
  carrying a `builtin` marker, so the `entry.tier === 'builtin'` short-circuit would silently
  extend to them. Resolve the rule while it still covers one case.
- **Do not "fix" S5 by refusing the id at boot.** The account tier is currently the ONLY supported
  path to an org-wide living document (see S3), so a code registration naming a tenant-tier id is
  the shape we tell deployments to use. The defect is the missing report, not the severity.
- **Every item here is an INTERNAL surface.** Facade options, registry seams, container wiring and
  persisted fragment rows are all pre-1.0, so no shim, dual-read or deprecation window is owed. Say
  so in each changeset.
- **The consumer's own workarounds are the deletion checklist.** Their exact pin on
  `prompt-fragments` plus a `check:fragment-pool` script goes after slice 6; their
  `Parameters<TaskTypeRegistry['register']>[0]` derivation is already unnecessary (S8); their
  substitution of the built-in `pl_build` for the pipeline they wanted goes after slice 3.

## Checked and genuinely fine

Recorded so nobody re-investigates, both confirmed:

- **`appliesTo` does not gate a run.** The run path folds a block's `fragmentIds` /
  `resolvedFragments` directly; `appliesTo` is read only by the relevance selector on the
  management surface. A narrow `appliesTo` can never drop a fragment named by
  `defaultFragmentIds`. Correct behaviour, and non-obvious from the field's doc comment.
- **An authored `brief` is never re-checked.** `resolveFragmentBrief` returns
  `{ kind: 'authored' }` before any ratio or length test, so authoring a brief per fragment is free
  and removes the condensation call. Worth stating in the reference doc as the recommended practice
  for a deployment shipping long standards.

One more thing to keep rather than fix: for a document whose URL is not settled, the consumer
shipped a POINTER fragment with two bodies, one citing the configured URL and one telling the agent
the document is missing and forbidding it from inventing the contents. That is the "absent and
empty must not render the same" rule applied correctly, and it should survive whatever S3 lands.
