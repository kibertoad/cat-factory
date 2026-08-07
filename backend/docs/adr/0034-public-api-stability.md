# ADR 0034: The public API is stable; the final pre-stability polish

- **Status:** Accepted (implemented)
- **Date:** 2026-08-03
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/server`), `sdk/*`, repo policy

Amends [ADR 0030](./0030-public-api-surface.md): the "flag breaking changes prominently" posture is
replaced by a hard stability commitment, and the breaking changes that were worth making at all were
made in the same change that adopts it.

## Context

ADR 0030 shipped `/api/v1` under the repo-wide pre-1.0 rule ("backwards compatibility is NOT a
goal"), softened for this one surface to "be deliberate about breaking callers; flag it in the
changeset". That posture was right while the surface had no consumers. It stops being right the
moment integrations and the four published SDK clients build on it: every wart then hardens into
either a permanent wart or a future broken caller, and "flagged in a changeset" is not a contract an
external consumer can read.

Three warts were known, each documented at the time rather than fixed:

1. **The headless job resource was split across two path roots.** `POST /api/v1/initiatives`
   created a resource whose reads, cancel and SSE stream lived under `/api/v1/jobs/*`. One
   resource, two names; the SDK surface papered over it with an `initiatives` group whose own
   entity is called a job.
2. **`publicTask.executionId` leaked internal vocabulary.** Everywhere else the public surface
   says "run" (`publicRun.runId`, `/api/v1/runs/:runId/decisions`, the webhook body's `runId`);
   the task projection alone said "execution", so a caller joining a task to its run had to know
   two names for one id.
3. **`POST /api/v1/tasks/:taskId/start` applied no pipeline admission**, so a plain `write` key
   could start a board pipeline that parks on a human decision: exactly the situation the `decide`
   scope exists to gate on the jobs surface. The decision-surface investigation that became
   [ADR 0043](./0043-public-decision-surface.md) recorded tightening it as an open question and
   noted it was "exactly the kind of change ADR 0030 says to flag prominently".

## Decision

**One last breaking change, then the door closes.** This change lands the three fixes and, in the
same PR, replaces the compatibility posture:

- `POST /api/v1/initiatives` moved to `POST /api/v1/jobs`; the whole job lifecycle (create, list,
  get, cancel, stream) now shares the `/api/v1/jobs` root. The SDK group is `jobs`, the OpenAPI tag
  is `Jobs`, and the wire schemas renamed accordingly (`CreatePublicJob`, `PublicJobAccepted`).
- `publicTask.executionId` is now `publicTask.runId`.
- `POST /api/v1/tasks/:taskId/start` applies the same parking rule as `POST /api/v1/jobs`: a
  pipeline that can park on a human requires a `decide`-scope key, refused as
  `403 pipeline_requires_decide_scope`. The refusal message names this surface's exit route
  (`POST /api/v1/tasks/:taskId/stop`), not the jobs cancel.
- **`canParkOnHuman` enumerates THREE park mechanisms**, widened here from two. An approval gate
  flag on an enabled step, an inline review or brainstorm kind, and a polling gate whose poll
  never times out because it is waiting on a person (`pollExhaustion: 'rearm'`, today only
  `human-review`). The third was missed on the first pass of this change and is the reason the
  widening had to happen here rather than later: `pl_full`, the shipped Adaptive build preset,
  carries a risk-gated `human-review`, so the flagship board pipeline was startable by a plain
  `write` key and could then park indefinitely on the one surface `/api/v1/runs/:runId/decisions`
  cannot answer at all. Under the commitment adopted below, adding it afterwards would itself have
  been a capability-narrowing break needing a migration path.

**From this change on, the public API is stable.** The commitment, stated in CLAUDE.md and binding
on every future change to `/api/v1`, the SDKs, or the webhook delivery contract:

- Additive changes are the normal mode and need only an OpenAPI `info.version` minor bump. The
  SDKs tolerate unknown fields and enum values by design, so an addition breaks no caller.
- Any non-additive change ships with an incremental migration path plus a version change: the old
  shape keeps working while the new one is served beside it (a new field beside the old one, a new
  `/api/v2` prefix for a path or semantics change), and removing the old half is a second, later
  change made only after consumers have had a release window to move.
- Narrowing what a scope may do is a break like any other and takes the same path.

## Rationale

- **The stability commitment and the last polish belong in ONE change.** Committing first would
  freeze the warts forever; polishing "later" under the old posture invites an open-ended series of
  "one more break". Doing both at once makes the boundary exact: everything before this change may
  break callers, nothing after it may.
- **`jobs`, not `initiatives`, as the unified root.** Four of the five job routes already lived
  under `/jobs`, the entity and its fields were already `job`/`jobId`, and the create accepts any
  public inline pipeline, of which initiative breakdown is merely the first. Renaming one route
  beat renaming four routes plus every field.
- **The scope tightening could not wait for the decision-surface slices.** The tracker recommended
  revisiting after A1..A4 close the answerability gap, but under a stability commitment the
  permissive rule would have become un-tightenable: taking capability away from a live `write` key
  is a break. The stricter rule is the one that can be relaxed later without breaking anyone
  (widening admission is additive).
- **Board runs stay recoverable either way**: a parked board run is visible in the SPA and a human
  can answer it there, and `stop` clears it. The rule is about what a key may set in motion, not
  about recoverability.

## Consequences

- **CLAUDE.md's "Backwards compatibility is NOT a goal" section is now scoped to internals**, with
  the public surface carved out as stable. ADR 0030's "additive forever, flag breaks prominently"
  consequence is superseded by this ADR.
- **Existing consumers of the three renamed shapes must update** (this is the last time that
  sentence appears): `POST /initiatives` is gone, `publicTask.executionId` is gone, and a `write`
  key can no longer start a parking board pipeline. The SDKs shipped the rename as a version bump
  (`initiatives` group to `jobs`; `task.executionId` to `task.runId` in each language's casing).
- **`canParkOnHuman` is a static enumeration and stays one.** It sees approval gates, the four
  inline parking kinds, and the unbounded human-wait gates; a park raised dynamically mid-run (an
  agent-raised decision, a judge `park` disposition) is not statically knowable at start time and
  is deliberately out of the admission rule. Widening the enumeration later only refuses more,
  which is the direction the commitment permits at a scope boundary only with a migration path;
  prefer closing the answerability gap ([ADR 0043](./0043-public-decision-surface.md)) instead.
  That is precisely why the `human-review` gate had to be swept in NOW rather than tracked: every
  member the enumeration is missing on the day the door closes is a member that gets expensive to
  add.
- **Which gate kinds park is a shared constant with a drift guard, not a second opinion.**
  `HUMAN_WAIT_GATE_KINDS` lives in `@cat-factory/contracts` because the two packages that must
  agree cannot see each other: `@cat-factory/gates` owns the truth as each gate's `pollExhaustion`
  declaration, and `@cat-factory/server`'s admission rule needs the same answer at HTTP request
  time. Reading it live was rejected: a registered gate's declaration is only reachable by invoking
  its factory with an engine context, and building a fake one inside a request handler to
  interrogate a static fact is a shortcut, not a design. `human-wait-parity.test.ts` derives its
  expectation from the gate REGISTRY, so a new built-in gate that waits on a human fails the build
  until it is classified.
- **A DEPLOYMENT's own unbounded-wait gate is not seen by the rule**, for the same reason, and this
  is stated rather than silently assumed. Such a run is admitted for a `write` key and its park is
  answered in the app. The residual gap is bounded (a deployment that registers a human-wait gate
  also controls the keys it mints) and closing it means moving the declaration out of
  `GateDefinition` and onto registration, which is a gate-registry change, not an API one.
- **The decision-surface additions (A1..A6, B1..B2, C1..C2) are unaffected**: all are additive.
  Their tracker stays live; its open question about the start path is settled by this ADR.
- **`docs/openapi.json` `info.version` policy**: minor for additions, and a major only ever
  alongside a new path prefix. The generator's comment states the rule beside the constant.
