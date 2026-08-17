# ADR 0058: What a third-party acceptance suite could not do, and which halves we closed

- **Status:** Accepted (implemented)
- **Date:** 2026-08-17
- **Context layer:** `@cat-factory/acceptance-kit`, `@cat-factory/cli`, the `/api/v1` provisioning
  surface, and `backend/internal/acceptance` as their in-repo consumer.

## Context

The kit ([`README`](../../packages/acceptance-kit/README.md)) is published so a deployment can cover
its OWN providers, agent kinds and gates without copying the platform's suite. The first consumer to
actually do that built a suite against a deployment whose environments are **Kargo PREnvs**,
provisioned by an environment backend that deployment registers itself, and handed back thirteen
findings: eight against the kit, four against `/api/v1`, one a platform behaviour worth recording.
Each named what was hit, how it was verified, and what it cost.

Two things make that list worth acting on as a whole rather than case by case. It is the first
evidence of what the kit is like to use from OUTSIDE this repo, where every seam that "a suite can
just write itself" is a seam somebody re-derived from reading our source. And it surfaced a real
defect in the platform's own suite (below), which is what a second consumer is for.

## Decision

### Closed in the kit

- **A resource discipline beside the run one** (`resource.ts`). `resume.ts` records a task at
  creation and a run at start because re-filing a run wastes an afternoon. A suite that provisions
  its own infrastructure needs the identical discipline for a worse reason: a teardown takes the
  provider's id plus whatever the provision captured, and NEITHER can be re-derived, so a process
  killed between `provision()` returning and the first status poll leaks a machine nothing on disk
  can name. `acquire` / `release` / `reclaimAll`, generic over a ledger slot, with a release recorded
  only when the provider AGREES the resource is gone.
- **`PassOptions.onSettled`**, awaited after the scenarios and folded INTO the closing words. Without
  it the only way to release something is to wrap `runPass`, which prints the reclaim block after the
  words written to be the last thing an operator reads. It runs on the failure path, and its own
  throw is rendered rather than allowed to replace the scenario failure.
- **The third verdict constructor** (`unknown`) and **`Prerequisite.probe`**. Rule 2 makes `unknown`
  the state a suite reaches most often by hand, and it shipped as the one state with no constructor.
  The per-check probe context lets a check reaching a host that is NOT the deployment get kernel's
  transport classification, which the pass-level context (correctly) cannot give it.
- **`ConfigProblem` exported.** It is the element type of a public method's return.
- **Provider-neutral evidence prose.** `checkEphemeralEnvironment` claimed "the disposer reclaimed
  the NAMESPACE", which lands verbatim in the failure output of an operator whose environment is a
  VM behind a balancer.
- **The description-size branch** (`briefFields`), read from the contracts' own caps.
- **The console credential prompt**, as an opt-in subpath (`@cat-factory/acceptance-kit/console-credential`).
- **The `.env` merge**, published from `@cat-factory/cli` beside the `renderEnvFile` it completes.

### Closed on `/api/v1` (spec `1.57.0`)

- `PublicServiceProvisioning` gains `{ type: 'custom', manifestId, manifestPath? }`, and the service
  projection serves it.
- `GET /api/v1/environments/connections`.
- `GET /api/v1/repos/{owner}/{name}/contents?path=&ref=`.

### Declined: publishing the engine half of a custom environment connection

The report asked for `publicEnvironmentConnectionSchema` to gain
`{ engine: 'remote-custom', custom: { backendKind, manifestId, manifest, acceptsManifestId } }`, so a
headless caller could register the handler as well as pin the service.

**We are not doing that, and the reason is the `manifest`.** Registering a custom handler means
supplying an `environmentManifest`, whose `providerConfig` is an open `Record<string, unknown>` by
design: it is the seam every registered backend puts its own settings through, and this repo evolves
it freely because nothing external depends on its shape. `/api/v1` is the opposite (ADR 0034): what
lands there is frozen, and reshaping it needs a `/api/v2` and a deprecation window. Publishing an
intentionally-open record onto a permanently-closed surface trades a small ergonomic win now for a
migration we would owe forever, and it would do it for the half of the problem a composition root
already solves cleanly (`startLocal({ seedEnvironmentHandlers })` works today and needs no API).

The report offered this trade itself ("Reading it back is the smaller ask and buys most of the
value"), and that is what shipped: a caller pins by a `manifestId` the deployment already registered,
which is a closed and stable value, and confirms the handler behind it landed through the new list.

### Declined: a directory listing beside the file read

The file read answers ONE path. A listing has its own frozen-forever questions (pagination,
recursion, what a truncated provider tree reports), and answering them by accident in the same change
that needed a file is how a surface acquires a shape it cannot revise. `GET /services/{id}/spec`
remains the structured read for the one tree the platform itself understands.

## Rationale

**A defect the report found in our own suite, which is the strongest argument for having a second
consumer.** A task `description` caps at 2,000 characters. Rendering
`backend/internal/acceptance/src/instructions.ts` measures the two scaffold briefs at **2,507** and
**2,697**, and scenario 01 passed them straight to `description`, so the platform's own acceptance
pass could not create its first task, and would have discovered that as a `422` after an operator had
created two repositories and wired a workspace. The kit now ships the branch (over the cap, the brief
becomes an attached document, which is this surface's own documented path for spec-sized input; under
it, byte-for-byte the prior behaviour), the cap is a named constant the branch READS rather than
restates, and the suite routes every task through it.

**Where the line fell on the public API.** Three of the four `/api/v1` findings were about a READ
that did not exist, and reads are the cheap, safe direction: each returns a projection the platform
already computes, publishes nothing a caller could not reach through the board or its own connection,
and turns an unknowable into a checkable prerequisite. The fourth was a WRITE that would have frozen
an internal shape, and that is where the answer is no.

**Where the line fell in the kit.** The kit's own rule is that it must never acquire a prerequisite,
a scenario, a configuration schema, or anything that prompts a human, because each is a fact about
ONE suite. The console credential prompt looks like a violation and is not: what it holds is not a
fact about a suite but the platform's own `428` protocol plus about 200 lines of terminal handling
whose Windows half fails as a bare `setRawMode EPERM`. Shipping it behind a subpath keeps the base
entry point free of console code, so a CI-only suite cannot import a prompt by accident, and
importing the path is the decision to be asked.

## Consequences

- The kit gains two modules with **no in-repo consumer** (`resource.ts`, and `onSettled` beside it).
  That is a real cost: this repo's own suite provisions its environments THROUGH the platform, so
  nothing here exercises the acquire/release path except its unit tests. It is accepted because the
  shape is not speculative (it is a working implementation upstreamed by the consumer that wrote
  it), but a future change to it has only tests to answer to.
- `@cat-factory/cli` now publishes general `.env` merge helpers, which widens what that package is
  for. It was already the home of `renderEnvFile`; this completes the pair rather than opening a new
  concern, and the SECRET LIST stays the caller's because only a caller knows its own.
- The `custom` provisioning variant means `provisioning.type` must be narrowed before
  `manifestSource` is read. That is a compile error in consumers, which is the point: it is a
  discriminated union and was previously a one-member one.
- `resolveRepoFilesForCoords` is now surfaced on the server container by BOTH facades. A facade that
  wires a VCS and forgets it serves a 503 from the file read rather than failing to boot.
