# Initiative: public API headless completeness (repair, provision, and read what you judge)

**Status:** in progress; A1 and A5 landed · **Owner:** core · **Started:** 2026-08-07

**Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/orchestration`,
`@cat-factory/server`) + the four SDKs and the MCP facade
**Builds on:** [ADR 0030](../../backend/docs/adr/0030-public-api-surface.md) (the `/api/v1`
surface), [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md) (the stability
commitment every slice here is bound by), and
[ADR 0043](../../backend/docs/adr/0043-public-decision-surface.md) (the decision surface, whose
two carried-forward items are B1 and B2 below).

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the next
> slice; update the checklist at the end of each PR.

## Goal & rationale

ADR 0043 closed the asymmetry it was opened for: of the surfaces a pipeline can park on, a
`decide` key can now answer every one it can start. That was the question "can a headless caller
get a run UNSTUCK". A sweep of the surface against the internal controllers it projects finds a
different question still open, and it splits three ways:

**A headless caller cannot REPAIR an input the platform itself refused.** The pre-dispatch input
gate exists to park a run for free when a task is structurally unactionable, and it names exactly
which input is missing. Four of its seven issue codes name a task-type field, and
`PATCH /api/v1/tasks/:taskId` accepts `title` and `description` alone. So the platform can accept
a task, refuse to run it, say precisely what to go and fix, and offer no way to fix it. The
public-decisions contract's own doc comment tells the caller to "edit it over
`PATCH /api/v1/tasks/:taskId` first", which is true for three codes and false for four.

**A headless deployment cannot PROVISION the board it drives.** `/api/v1` lists services and can
create a task under one; nothing creates a service, links a repo to one, or expresses a dependency
between two tasks. C1 (webhook enrolment) and E2 (key provisioning) already won this exact
argument for their own gaps: a deployment whose operator is headless could drive every part of the
API except the one act it had to open a browser for. Board setup is the last one left.

**A caller asked to JUDGE a run cannot read all of what it is judging.** E1 shipped the artifact
bytes, which quietly closed the visual-confirmation caveat the docs still carry, but the artifact
LIST is `listByExecution` and reference designs are block-anchored with no execution id. So a
caller enumerating a run's artifacts sees the screenshots and not the references it is meant to
compare them against: absent rendering as empty, on the one surface whose whole job is to say what
a run proved.

The unifying test for anything proposed here: **an integration should never have to fall back to a
browser to finish something this API let it start.** Nothing in this tracker is a new engine
capability; every slice is the external counterpart of a service method the SPA already calls, or
in A1's case a field the internal patch schema already accepts.

## Validated facts

Verified in the source; the cited files are the authorities.

1. **`updatePublicTaskSchema` is `{ title?, description? }`**
   (`contracts/src/public-api.ts:393`), and the handler passes it straight to
   `boardService.updateBlock` (`PublicApiController.ts:927`).
2. **The internal `updateBlockSchema` ALREADY accepts `customTaskTypeFields`**
   (`contracts/src/requests.ts:192`), validated through the same door the create form goes
   through. So the custom half of A1 is a contract widening with no service work.
3. **The internal patch DELIBERATELY excludes the BUILT-IN per-type fields**, and the comment
   above it says why: a `review` task's PR reference is verified against the provider and folded
   into the description at creation, and "offering them here would quietly skip that". So
   `stepsToReproduce` / `successCriteria` / `prNumber` are write-once on **both** surfaces:
   `stepsToReproduce` appears in `AddTaskModal.vue` and in no edit surface anywhere in the SPA.
4. **Four of the seven input-gate issue codes name a field neither surface can patch**
   (`contracts/src/input-gate.ts:43`): `reproduction_missing`, `review_target_missing`,
   `success_criteria_missing` (built-in fields, fact 3) and `required_field_missing` (a custom
   type's declared field, fixable internally per fact 2 and not publicly). The gate's own doc
   calls the first of those "the single most expensive input gap there is".
5. **`createPublicTaskSchema` accepts all of them.** `BUILTIN_PUBLIC_TASK_FIELDS` types the
   built-in per-type fields explicitly and `fields` carries the custom bag
   (`publicApi/taskTypeFields.ts`), so every value A1 needs is already expressible at CREATE and
   at no other moment.
6. **The public board surface is `listPublicServices` and nothing else.** The internal board
   contracts are `addFrame`, `addServiceFromRepo`, `addModule`, `addEpic`, `assignEpic`,
   `updateBlock`, `move`/`resize`/`reparent`, `remove`, `archive`/`restore` and
   `toggleDependency` (`contracts/src/routes/board.ts`).
7. **`autoStartDependents` is real engine behaviour** (`PostMergeBoardController`) and
   `updateBlockSchema` carries the per-task toggle, so dependencies already change what runs
   when. A headless caller filing a batch of related tasks can express no ordering at all.
8. **`listPublicRunArtifacts` calls `store.listByExecution(workspaceId, runId)`**
   (`PublicEvidenceController.ts:139`), and `VisualConfirmationController.visualPairs` sources
   references from `store.listByBlock` with the comment "the block's uploaded reference design
   images (carry no executionId)". The blob endpoint is keyed on `(workspaceId, artifactId)`
   alone, so both halves are FETCHABLE and only one half is LISTED.
9. **The "app-resolvable only" caveat on `publicVisualConfirmDecisionSchema` is stale.**
   `GET /api/v1/artifacts/:artifactId/blob` resolves the ids that projection carries, for actual
   and reference alike. ADR 0043 repeats the caveat, having quoted the schema.
10. **Exactly ONE built-in pipeline is `public: true`** (`pl_initiative_breakdown`, `seed.ts`),
    so out of the box `POST /api/v1/jobs` is a single-purpose endpoint and every other headless
    run goes through a board task. Not a defect, but it is why the board-provisioning gap (A2)
    bites harder than the surface's shape suggests.

## Target pattern

Every slice is additive under ADR 0034: a new optional field, a new endpoint, a new enum member.
Nothing here renames, retypes or re-scopes anything already served. Each one follows the shape ADR
0030 established and ADR 0043 repeated:

- **Delegate to the SAME service method the SPA controller calls.** No parallel logic, so an
  invariant cannot differ by surface.
- **One rule at every door.** A1 in particular must run the create path's own
  `withDescriptorFieldDefaults` → `validateDescriptorFields` → `sanitizeDescriptorFields` chain,
  or the two doors disagree about the same descriptor, which is the defect the reusable-operations
  work closed once already ([ADR 0042](../../backend/docs/adr/0042-reusable-operations.md)).
- **A new endpoint needs a `scripts/sdk/surface.mjs` entry** or generation fails, and a new
  resource GROUP touches hand-written code in the Go client and exercises spelling paths in
  Python and the MCP facade (ADR 0043's consequences).
- **Regenerate `docs/openapi.json`, bump `info.version` minor, update
  [`public-api.md`](../../backend/docs/public-api.md)** in the same PR.

## Slices, in priority order

| #   | Slice                                                       | Sev | Status  | PR                                                          |
| --- | ----------------------------------------------------------- | --- | ------- | ----------------------------------------------------------- |
| A1  | Repair a refused input: `fields` on the task PATCH          | P1  | ✅ done | [#1808](https://github.com/kibertoad/cat-factory/pull/1808) |
| A2  | Board provisioning: create a service, link a repo           | P1  | ⬜ todo |                                                             |
| A3  | Task dependencies over the API                              | P2  | ⬜ todo |                                                             |
| A4  | The artifact list under-reports reference designs           | P2  | ⬜ todo |                                                             |
| A5  | Retire the stale visual-confirmation caveat (docs only)     | P2  | ✅ done | [#1808](https://github.com/kibertoad/cat-factory/pull/1808) |
| A6  | Documents after create: list, attach, detach                | P2  | ⬜ todo |                                                             |
| B1  | A deployment-registered wait gate is invisible to admission | P2  | ⬜ todo |                                                             |
| B2  | Step output on `GET /api/v1/tasks/:taskId/run`              | P3  | ⬜ todo |                                                             |

### A1: repair a refused input (the pilot)

`updatePublicTaskSchema` gains `fields`, accepted for the same types and validated through the
same chain as `createPublicTaskSchema.fields`, so a caller that hits a blocking input-gate finding
can supply the named value and re-run instead of deleting and recreating. Deleting is not a
workaround: it loses the task id every stored reference points at, its ticket claim (which then
refuses every future filing of that ticket) and its attached documents.

**It splits in two, and the halves are not the same size.** The CUSTOM bag is a contract widening:
the internal patch already accepts it (fact 2). The BUILT-IN per-type fields are the harder half
and the more valuable one, because three of the four unfixable codes are theirs, and fact 3 is a
real obstacle rather than an oversight: their creation-time resolution has side effects the patch
path does not repeat. Land the custom half first, then decide the built-in half deliberately.
There are two honest shapes for it and this tracker does not pick one:

- **Repeat the resolution on patch** (verify the PR reference, re-fold it into the description).
  Correct, and it makes the patch path do something a caller may not expect from a field write.
- **Accept only the fields with no resolution** and refuse the rest with a `reason` naming them.
  Smaller, and it leaves `review_target_missing` unfixable, which is one of the three.

Whichever is chosen, **fix the doc comment in `contracts/src/public-decisions.ts` in the same PR**:
it currently tells callers to PATCH, which is the claim this slice exists to make true.

**SHIPPED — both halves in one PR, on the first shape.** The two were not worth splitting once the
built-in half turned out to need no new mechanism, only creation's own two collaborators called
again. What the tracker had not seen is that the obstacle is narrower than "the fields have
resolution": three of the four built-in codes name a field with NO resolution at all
(`stepsToReproduce`, `successCriteria`, `researchQuestion`), and the review target's resolution
splits in two, of which only the DESCRIPTION FOLD is problematic. Verifying the pull request
against the provider simply repeats; the fold is a prepend, so repeating it would leave the
description naming two pull requests.

The fold is therefore made idempotent BY CONTENT rather than by a marker: the preamble is
recomputed from the fields as they stand, and where it is the description's prefix it is swapped
for the new one. Nothing folded before (the `review_target_missing` repair itself) prepends
cleanly; a description since rewritten by hand REFUSES, because the platform can no longer tell
which part of it was the fold. A marker would have been the obvious alternative and is worthless
here: no review task in any database carries one, and the tasks this exists to repair are exactly
the ones that predate it.

Two things the tracker got wrong, corrected here rather than left to trip the next slice:

- The internal `updateBlockSchema` does NOT gain the built-in fields under `customTaskTypeFields`.
  The halves are validated by different authorities (a schema here, a deployment's descriptor
  there), so the request carries `builtinTaskTypeFields` beside it and each replaces its own half.
- **Merge vs replace is a DOOR question, not a bag question.** The internal keys replace, as the
  app's form has always sent them; the PUBLIC `fields` merges, because this API does not serve the
  bag back and a replacing patch would ask a caller to restate values it cannot read. That
  asymmetry lives in `publicApi/taskTypeFields.ts` and nowhere near the rule.

### A2: board provisioning

A public counterpart to `addServiceFromRepo` and `addFrame`, at `admin` scope. Two things to
settle rather than assume:

- **Scope.** `admin` by ADR 0034's rule that between two close readings the reversible one wins:
  a scope can be relaxed later, never tightened. Creating a service is board structure, which is
  what `admin` already covers for keys and the webhook.
- **How much of the board vocabulary.** Services and the repo link are the whole of the gap;
  modules, epics, positions and reparenting are board ERGONOMICS for a human looking at a canvas,
  and exposing them would publish a coordinate system into a surface frozen forever. Start with
  the two and let a consumer ask for the rest.

The repo link is the load-bearing half: a service frame with no linked repo cannot run anything
(`resolveRepoTarget` throws by design, with deliberately no first-repo fallback), so a slice that
creates frames and cannot link them ships an endpoint whose output is unusable.

### A3: task dependencies

`POST /api/v1/tasks/:taskId/dependencies` mirroring `toggleDependency`, plus the `autoStartDependents`
toggle on the task PATCH. Today an integration that files five related tasks and starts them gets
five racing runs against one repository, and the platform has the mechanism to serialise them and
no way to be told to.

### A4: the artifact list under-reports reference designs

`listPublicRunArtifacts` should return the run's execution-anchored artifacts UNION the reference
designs anchored on its task's block, or state that it does not. The current shape is the
degrade-loudly rule inverted: a caller comparing counts concludes the run captured screenshots
against nothing, when the references are there and individually fetchable.

Decide it as a projection question, not a query one: the two sets have different anchors on
purpose (a reference outlives any single run), so folding them may want a `scope` field on
`publicRunArtifact` saying which anchor each row came from, rather than a silent union.

### A5: retire the stale caveat (docs only)

Fact 9. Three places say the images are not readable over `/api/v1`: the schema doc on
`publicVisualConfirmDecisionSchema`, ADR 0043, and `public-api.md`. All three predate E1. Cheapest
item here and the most misleading one left in place, because it tells a caller not to attempt
something that works.

**SHIPPED, and it was TWO places, not three.** ADR 0043 never carried the caveat: it names the
artifact blob among the reads it inherits and says nothing about resolvability. Fact 9 asserted a
third site from the shape of the other two rather than from a grep, which is the failure mode a
"validated facts" section exists to prevent; the remaining two (the schema doc, plus the
`visual-confirmation` bullet in `public-api.md`) are fixed, each stating that the caveat outlived
its cause so the correction is not silently re-litigated.

### B1: a deployment-registered wait gate is invisible to admission

Carried from ADR 0043 unchanged, including the shape of the real fix: let a gate declare
`pollExhaustion` at REGISTRATION time and have `parkSurfacesOf` read the registry, which DELETES
`HUMAN_WAIT_GATE_KINDS` and its drift guard rather than adding a mechanism beside them. It is a
change to the `GateRegistry` seam (every registration site, both facades). Reading it at HTTP
request time instead means standing a fake engine context up per admission call, which is a
shortcut and not a design.

### B2: step output on the run read

Carried from ADR 0043. `publicJob` carries a `result`; `publicRun` carries step states, the PR and
the error, but no step output, so a board task running an inline-only pipeline produces a
deliverable the API cannot read. Lowest priority: the container pipelines that dominate board work
deliver through the PR.

## Considered and NOT recommended

- **Board ergonomics on the public surface** (positions, sizes, reparenting, archive/restore).
  A canvas coordinate system does not belong in a surface that is frozen forever, and no
  integration needs one. See A2.
- **Widening `POST /jobs` by marking more built-ins `public: true`.** Fact 10 makes that look like
  the obvious fix and it is the wrong axis: `public` means "safe to run headlessly against a
  supplied brief, touching no repository", which is a property of the pipeline, not a knob. A
  deployment wanting more registers its own.
- **`since` on the task list.** Still not deliverable off `blocks` (no timestamp column), and ADR
  0030's reasoning stands. Worth noting in `public-api.md` rather than re-litigating: a caller
  that wants incremental polling can already have it at `read` scope from
  `GET /api/v1/debug/runs?since=`, which pages over `agent_runs` and does carry timestamps. That
  is a pointer, not a slice.
- Everything ADR 0043 already recorded as not recommended (the fork-decision chat, recurring
  schedules, `POST /bootstrap`, per-step lifecycle webhooks) stays not recommended, for the
  reasons recorded there.

## Gotchas any slice here inherits

All of ADR 0043's, which are not restated. The two that bite hardest in this tracker's territory:

- **Add the surface to `PUBLICLY_ANSWERABLE_PARK_SURFACES`** if a slice ships an answer path, and
  first ask whether `parkSurfacesOf` produces the surface at all.
- **A request-body field may not carry a valibot `default`**, and an enum reused across DTOs is
  deduped by value-set into a name taken from whichever DTO the walk reaches first. A1 adds a
  field to an existing request body and A2 adds new DTOs, so both are exposed to these.

One more, specific to A1 and A6: **a write that lands PARTIALLY is worse than one that refuses.**
Both slices edit a task that may already carry a ticket claim and attached documents, and D1/D2
established the rule for that direction (resolve and refuse before the block exists, roll the task
back if an attachment does not land). An edit path has no block to roll back, so it has to refuse
whole rather than apply what parsed.
