# ADR 0050: Public-API headless completeness (repair, provision, relate, and read what you judge)

- **Status:** Accepted (implemented)
- **Date:** 2026-08-08
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/orchestration`, `@cat-factory/integrations`, `@cat-factory/gates`,
  `@cat-factory/server`) + the four SDK clients and the MCP facade

Supersedes the `public-api-headless-completeness` initiative tracker, whose committed scope is
complete. Builds on [ADR 0030](./0030-public-api-surface.md) (the `/api/v1` surface),
[ADR 0034](./0034-public-api-stability.md) (the stability commitment every slice here is bound by)
and [ADR 0043](./0043-public-decision-surface.md) (the decision surface, whose two carried-forward
items are settled here).

## Context

ADR 0043 closed the asymmetry it was opened for: of the surfaces a pipeline can park on, a `decide`
key can now answer every one it can start. That was the question "can a headless caller get a run
UNSTUCK". A sweep of the surface against the internal controllers it projects found a different
question still open, splitting four ways.

**A headless caller could not REPAIR an input the platform itself refused.** The pre-dispatch input
gate exists to park a run for free when a task is structurally unactionable, and it names exactly
which input is missing. Four of its seven issue codes name a task-type field, and
`PATCH /api/v1/tasks/:taskId` accepted `title` and `description` alone. So the platform could accept
a task, refuse to run it, say precisely what to go and fix, and offer no way to fix it.

**A headless deployment could not PROVISION the board it drives.** `/api/v1` listed services and
created tasks under one; nothing created a service, linked a repository to one, or expressed an
ordering between two tasks. C1 (webhook enrolment) and E2 (key provisioning) had already won this
exact argument for their own gaps: a deployment whose operator is headless could drive every part of
the API except the one act it had to open a browser for.

**A caller asked to JUDGE a run could not read all of what it is judging.** The artifact LIST was
`listByExecution`, and reference designs are block-anchored with no execution id, so a caller
enumerating a run's artifacts saw the screenshots and not the references it is meant to compare them
against: absent rendering as empty, on the one surface whose whole job is to say what a run proved.
A board task running an inline-only pipeline had the same problem one level up: its deliverable is a
step's prose output, and the run projection carried step states, the pull request and the error but
no output.

**And the admission rule could not see a gate a DEPLOYMENT registered.** `parkSurfacesOf` read a
hand-kept constant naming the shipped rearming gates, so a deployment's own unbounded-wait gate was
admitted for a plain `write` key and then parked forever with nothing able to name the surface.

The unifying test for everything here: **an integration should never have to fall back to a browser
to finish something this API let it start.** Nothing in this ADR is a new engine capability; every
piece is the external counterpart of a service method the SPA already calls.

## Decision

Eight additive slices, all under ADR 0034's rule (a new endpoint, a new optional field, a new enum
member; nothing renamed, retyped or re-scoped), plus one change to an internal registry seam.

### 1. Repair a refused input: `fields` on the task PATCH

`updatePublicTaskSchema` gained `fields`, accepted for the same types and validated through the same
`withDescriptorFieldDefaults` → `validateDescriptorFields` → `sanitizeDescriptorFields` chain as
`createPublicTaskSchema.fields`, so the two doors cannot disagree about one descriptor.

The obstacle turned out narrower than "the built-in fields have creation-time resolution": three of
the four built-in codes name a field with NO resolution at all (`stepsToReproduce`,
`successCriteria`, `researchQuestion`), and the review target's resolution splits in two, of which
only the DESCRIPTION FOLD is problematic. Verifying the pull request against the provider simply
repeats; the fold is a prepend, so repeating it would leave the description naming two pull requests.

The fold is therefore idempotent BY CONTENT rather than by a marker: the preamble is recomputed from
the fields as they stand, and where it is the description's prefix it is swapped for the new one. A
description since rewritten by hand REFUSES, because the platform can no longer tell which part of
it was the fold. A marker would have been the obvious alternative and is worthless here: no review
task in any database carries one, and the tasks this exists to repair are exactly the ones that
predate it.

**Merge vs replace is a DOOR question, not a bag question.** The internal keys replace, as the app's
form has always sent them; the PUBLIC `fields` merges, because this API does not serve the bag back
and a replacing patch would ask a caller to restate values it cannot read.

### 2. Board provisioning: `GET /api/v1/repos` and `POST /api/v1/services`

A public counterpart to `addServiceFromRepo` and `addFrame`, at `admin` scope (board STRUCTURE,
which is what `admin` already covers for keys and the webhook), plus the repository discovery read
at `read` that makes it usable: the create takes a provider repo id and there was nowhere to learn
one.

Both branches delegate to the board service, so every guard holds identically, including the
account-wide dedupe that MOUNTS a shared service rather than duplicating it. `GET /api/v1/repos`
reports each repository's existing service, so a caller re-running its provisioning finds what it
created last time rather than discovering it through a `409`.

Four boundaries decided here rather than assumed:

- **No board coordinates.** Positions, sizes, reparenting, archive/restore and the module/epic
  vocabulary are ergonomics for a human looking at a canvas. `addFrameSchema.position` became
  OPTIONAL and both frame-creation paths now share one `nextFrameSlot` layout rule, which is what
  lets a caller with no canvas create a frame without publishing a coordinate system into a surface
  that is frozen forever.
- **The repository link is the load-bearing half.** A service frame with no linked repository cannot
  run anything (`resolveRepoTarget` throws by design, deliberately with no first-repo fallback), so
  a slice that created frames and could not link them would have shipped output the surface that
  made it cannot use. Creating an unlinked frame stays reachable as an intermediate state.
- **The shared-service mount is REFUSED here, and the discovery read says so in advance.** The
  account-wide dedupe answers with the service's frame block, which may be homed on another board.
  The app can render that (it composes mounts into the board it draws); this surface cannot address
  it at all, because every read on it is a workspace-scoped repository read, so a 201 naming that
  frame hands back a `serviceId` `GET /api/v1/services` will not list and
  `POST /api/v1/services/{id}/tasks` will 404 on. Answering with an unusable id is worse than
  refusing, because it reads as success. So `addServiceFromRepo` takes a `SharedServicePolicy`
  (`mount` for the app, `refuse` here) and the refusal carries
  `reason: repo_service_homed_elsewhere`. `GET /api/v1/repos` gained `linkedElsewhere` to match:
  `serviceId: null` alone said the choice was AVAILABLE for a repository the create will refuse,
  which steered a caller straight into it. Widening the public reads to resolve through mounts was
  the alternative and was rejected: it would put a second access semantic behind a surface whose
  isolation property is exactly that a key sees only blocks homed in its own workspace.
- **The monorepo rule is enforced in ONE place, against the flag as it will stand.** Both halves (a
  monorepo service names a subdirectory; a whole-repo service must not) live in the board service,
  which is the only layer that can see the flag after the request's own `monorepo` write. Restating
  either in the controller reads a value it does not have: an omitted `monorepo` leaves the stored
  flag alone, so whether a `directory` is legal is not a fact about the request. The second half was
  the silent one — dispatch reads a service's directory only while the repository is flagged a
  monorepo, so a directory stored against a whole-repo service is ignored at dispatch and the agents
  run at the repository root while the caller and the created service both say otherwise. And
  because the flag is repository-WIDE, it is written only once every refusal has had its chance: a
  422 that had already flipped it would move the working directory of every service that repository
  already backs.

### 3. Task dependencies, declared rather than toggled

`POST /api/v1/tasks/:taskId/dependencies` and `.../dependencies/remove`, plus `autoStartDependents`
on the task PATCH and `dependsOn` / `autoStartDependents` on the task projection.

**The public writes are EXPLICIT where the board's own gesture is a toggle**, and that is the whole
reason `BoardService.setDependency` exists beside `toggleDependency` rather than instead of it. A
human clicking an edge they can see means "flip it". A provisioning integration re-running its own
setup must CONVERGE, and a toggle would invert every edge it declared last time, silently, since
both calls succeed and the graph it asked for is the one it does not get. Deriving the explicit form
from the toggle at the call site would mean reading the graph first and racing whoever else is
editing it.

### 4. The artifact list carries both anchors, and says which

`GET /api/v1/runs/:runId/artifacts` returns the run's execution-anchored artifacts UNION the
task-anchored ones, each row carrying `scope: 'run' | 'task'`.

Decided as a PROJECTION question rather than a query one: the two sets have different anchors on
purpose (a reference outlives any single run), so folding them silently would make "the run captured
3 screenshots" unreadable off a list of 5. A row satisfying both anchors is emitted once, as `run`,
so no count taken off the list double-reports it.

The list stays UNPAGED, and folding in the task half is what made the second half of that claim
owe an enforcement. "Bounded by construction, size computable before the request" had rested on the
capture path's per-run row cap; the human upload path had per-file byte ceilings and no row cap at
all, so the block half quietly withdrew the guarantee the contract rests on. Both halves now carry a
standing row cap through one shared check (`artifactSetCap`), needing a `countByBlock` beside the
existing `countByExecution` on the kernel port, mirrored D1 ⇄ Drizzle with a conformance assertion
that the count agrees with the list. The block cap REFUSES the newest upload rather than evicting an
older row: the uploader is present and can be told, and nothing here could know which of their
existing designs is the one to lose.

### 5. Documents after create: list, attach, detach

`GET|POST /api/v1/tasks/:taskId/documents` and `POST .../documents/detach`, taking the same two
forms creation takes.

Detach is a POST with a body rather than `DELETE .../documents/{id}`, because a document's identity
is `(source, externalId)` and the external id is a PATH for some sources
(`docs/architecture/adr-0001.md`), so a path segment would need escaping rules a caller has to get
right to address its own document. `DocumentLinkService.detachFromBlock` is scoped to the block, not
just to the ref: a by-ref detach would strip the document from whichever task is holding it, which
need not be the one named.

Attach runs the create path's own two-phase resolve, and it matters MORE here rather than less: an
`upload` mints a row, so resolving before the task is known to exist is what stops a caller retrying
against a mistyped id from filling the workspace with unreachable copies of one spec. There is no
block to roll back on this path (the task predates the request), so the ordering IS the guard.

### 6. Step output on the run read

`publicRunStep` gained `output` and `data`. The POINT READ serves them WHOLE rather than as a sized
excerpt, because `publicJobResult.output` already serves the same class of content whole and two
surfaces disagreeing about one fact is worse than a large response; raw diagnostics stay on
`/api/v1/debug/*`, which sizes every body before it serves it.

The SSE stream is the exception, and the reason is structural rather than a matter of taste. A frame
carries the WHOLE run, and re-emitting only on change bounds how OFTEN a frame is sent, not what is
in one: every frame after a step completes repeats that step's output, so a long pipeline's traffic
grows with the square of its own length. So the stream clips an oversized `output` to a preview,
withholds an oversized `data`, and marks the step `truncated: true`; a deliverable that already fits
rides through untouched and unflagged. The platform settles the same trade the same way one layer
down, for the run's `detail` JSON that is re-serialized on every step-progress write
(`MAX_HISTORY_OUTPUT_CHARS`).

The flag is what keeps this from being the degrade-loudly rule inverted: a clipped preview that did
not say so is indexed by a caller as the output itself, and its missing tail then reads exactly like
a step that wrote nothing more. Omitting the fields from stream frames entirely was the alternative
and is worse for the same reason — `output: null` already means "produced none".

### 7. A gate declares `pollExhaustion` at REGISTRATION

`pollExhaustion` moved from the `GateDefinition` a factory builds to the `GateRegistration`, with
`GateRegistry.pollExhaustion(kind)` reading it. `parkSurfacesOf` and the decision surface's
`unanswerableWaits` now ask the registry; `HUMAN_WAIT_GATE_KINDS`, `BUILTIN_GATE_KINDS` and their
drift guard are DELETED rather than joined by a second mechanism.

This is the shape ADR 0043 recorded, and it is what makes admission's four park mechanisms all
derive from a declaration a deployment's own registrations flow through. The alternative it
displaces is stated in ADR 0034 and stays rejected: reading a gate's declaration at HTTP request
time by standing a fake engine context up per admission call is a shortcut, not a design.

`unclassified_gate` survives with a NARROWER meaning: a step whose kind this process has no gate
registration for at all. That is still reachable (a retired gate, a node one build behind serving a
run started by one that is not), and it is the one case where "this deployment cannot say whether
that poll ever ends" remains the honest answer.

### 8. The stale visual-confirmation caveat, retired

Two places said the confirmation images are not readable over `/api/v1`, both predating the artifact
blob endpoint: the schema doc on `publicVisualConfirmDecisionSchema` and the `visual-confirmation`
bullet in `public-api.md`. Both now state that the caveat outlived its cause, so the correction is
not silently re-litigated. It was TWO places, not the three the tracker asserted: ADR 0043 never
carried the caveat, which is the failure mode a "validated facts" section exists to prevent.

## Rationale

**Every slice is the external counterpart of a service method the SPA already calls.** That is what
keeps the surface additive and keeps one rule at every door: no parallel logic, so an invariant
cannot differ by surface. Where a public door genuinely needed different SEMANTICS from the app's
(merge vs replace on the fields bag; explicit vs toggle on a dependency edge), the difference is
stated at the door and the shared rule underneath is untouched.

**Scope followed what each act CHANGES, not how destructive it feels.** Service creation is board
structure (`admin`); attaching a document or declaring an ordering edits ONE task a `write` key can
already create, edit and start, so putting those a rung higher would mean handing an integration
that files tickets a credential that can also merge pull requests. Where two readings were close the
REVERSIBLE one won: a scope can be relaxed later and never tightened.

**Where an enumeration existed, it was replaced by a derivation.** The wait-gate constant was the
last hand-kept member of the park rule, and a hand-kept list is precisely what missed the gate it was
written to cover in the first place.

## Consequences

- **`docs/openapi.json` steps to 1.31.0**: seven new operations, two new request fields, five new
  response fields. A consumer built against 1.30.0 keeps parsing every response it understood.
- **One population change is a real behaviour change for a consumer**, and it is the point of slice 4:
  `GET /api/v1/runs/:runId/artifacts` now returns task-anchored rows alongside run-anchored ones. A
  consumer counting rows to mean "screenshots this run captured" must filter on `scope: 'run'`.
- **`repos` is a new SDK resource group**, so it touched hand-written code in the Go client (the
  service field and its assignment), exactly as ADR 0043 recorded for a new group.
- **`GateDefinition.pollExhaustion` is gone.** Internal, so no migration: a deployment registering
  its own gate moves the declaration from the object its factory builds to the registration's
  options, where a stale one now fails to typecheck rather than being silently ignored.
- **A deployment's own unbounded-wait gate now refuses a `write` key**, where it was admitted before.
  That is a REFUSAL widening, which ADR 0034 permits at a scope boundary only with care; it is taken
  deliberately because the prior behaviour was the hole this ADR closes, and the run it admitted
  parked forever with nothing able to answer it. A deployment that registers such a gate also
  controls the keys it mints.
- **Two creation inputs still do not work in mothership mode**, unchanged by this work: `ticket` and
  `documents` read and upsert through repository methods still `pending` on the persistence
  allow-list, and the attach route added here inherits that. Moving those write surfaces is a slice
  of the mothership tracker.
- **Board ergonomics stay out** (positions, sizes, reparenting, archive/restore, modules and epics),
  and so does widening `POST /jobs` by marking more built-ins `public: true`: `public` means "safe to
  run headlessly against a supplied brief, touching no repository", which is a property of the
  pipeline rather than a knob. A deployment wanting more registers its own.
- **`since` on the task list stays not recommended.** Still not deliverable off `blocks` (no
  timestamp column). A caller wanting incremental polling can already have it at `read` scope from
  `GET /api/v1/debug/runs?since=`, which pages over `agent_runs` and does carry timestamps.
