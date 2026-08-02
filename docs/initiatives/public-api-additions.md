# Public API additions — completing the parked-decision surface

**Status:** proposed (investigation complete, nothing implemented)
**Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/server`)
**Builds on:** [ADR 0030](../../backend/docs/adr/0030-public-api-surface.md) (the `/api/v1` surface)
and [`headless-clarification-loop.md`](./headless-clarification-loop.md) (the `decide` scope and the
first answer surface).

## Goal

`/api/v1` covers the task lifecycle end to end **except when a run parks on a human**. The public
decision surface answers three park types; the engine has at least seven, and the public surface can
already CREATE runs that park on the other four. This tracker records what is missing, ranks it, and
records what was considered and rejected so the next iteration does not re-propose it.

The headline finding is not "an endpoint is missing" but an **asymmetry between what admission lets a
key start and what the decision surface lets it answer**. A caller can put a run into a state only
the SPA can get it out of.

## The gap, precisely

`buildDecisionList` (`PublicDecisionController.ts`) enumerates exactly three decisions:
`requirements-review`, `fork`, `judge`. Its own closing comment names the hole:

> a run parked on a surface this projection doesn't model yet (a plain approval gate, a human-test
> window) still reports `parked: true` with an empty list rather than silently claiming all is well.

That is honest reporting of an incomplete surface, not a bug — but the reporting is all a caller
gets. Two independent paths lead into it:

**1. The initiative surface admits parks it cannot answer.** `PARKING_INLINE_KINDS`
(`publicApiAdmission.ts`) lists four kinds, and admitting any of them is what the `decide` scope
buys. Only ONE of the four is answerable:

| Parking inline kind       | Public answer path                        |
| ------------------------- | ----------------------------------------- |
| `requirements-review`     | ✅ `/decisions/requirements/*`            |
| `clarity-review`          | ❌ none (`/blocks/:id/clarity-review/*`)  |
| `requirements-brainstorm` | ❌ none (`/blocks/:id/brainstorm/:stage`) |
| `architecture-brainstorm` | ❌ none (same)                            |

Clarity and brainstorm are separate orchestration modules with their own repositories, deliberately
mirroring requirements — so `buildDecisionList`'s single `container.requirements` read cannot see
them, and a `decide` key that starts such a pipeline gets a run it can only cancel.

**2. `POST /api/v1/tasks/:taskId/start` applies no pipeline admission at all.** Unlike
`POST /api/v1/initiatives`, the board-task start path never calls `isInlineOnlyPipeline` or
`canParkOnHuman`. Its only refusals are archived-service, pipeline-required, and the personal-model
gate. So a plain `write` key — one deliberately NOT granted `decide` — can start any board pipeline,
including one carrying an approval gate on an enabled step, and park it.

That asymmetry is defensible on its own terms (a board task is a first-class board citizen; the
inline-only rule exists to keep the INITIATIVE surface off GitHub, not to constrain board work). It
becomes a defect only in combination with the missing answer paths: the `decide` scope is supposed to
be the operator asserting "this integration is the headless overseer for these runs", and a `write`
key can currently create the overseer's job without the scope that gates it.

**The notification inbox is not the escape hatch.** `notificationActEffect` handles `merge_review`,
`pipeline_complete`, `merge_tag_request`, `ci_failed`, `test_failed` and `key_drift`. None of them
resolves an approval gate, a clarity review or a brainstorm round.

**Recovery exists, so nothing is stuck forever**: `POST /api/v1/jobs/:id/cancel` and
`POST /api/v1/tasks/:taskId/stop` both clear a park. The cost is the run's work, not the workspace.

## Slices, in priority order

Each is the external counterpart of a service method the SPA already calls — the shape ADR 0030
established. None needs new engine machinery.

### A1 — Approval gates (highest value, lowest cost) ⬜

The internal pair already exists: `POST /executions/:executionId/steps/:approvalId/approve` and
`…/request-changes` (plus reject, a terminal `rejected` failure the board can retry).

The state rides `step.approval` (`stepApprovalSchema`: `id`, `status`, `proposal`, `feedback`,
`comments`), so the decision projection is a **pure read off the run `buildDecisionList` already
holds** — no extra repository round-trip, exactly like the `judge` decision it sits beside. That is
what makes this the cheapest slice and the one to pilot on.

Model it on `toJudgeDecision`. The `proposal` is agent-authored text crossing a rendered surface;
project it as data, and keep the "possibly edited proposal" affordance OUT of v1 unless a consumer
asks — approve/request-changes/reject is the whole lifecycle.

### A2 — Agent-raised decisions ⬜

`POST /executions/:executionId/decisions/:decisionId` (`resolveDecisionContract`). Distinct from an
approval gate: an agent raises it and resolving RE-RUNS the same step. Same projection shape.

### A3 — Clarity review (bug-report triage) ⬜

Mirrors requirements exactly — same `IterativeReviewService` shape, same reply / set-status /
incorporate / re-review / proceed / resolve-exceeded verb set. The public routes should mirror
`/decisions/requirements/*` verb for verb; the only real work is a second module read in
`buildDecisionList` and a `clarity-review` decision kind.

### A4 — Brainstorm dialogues ⬜

Both stages (`requirements`, `architecture`). Same verb set again, but keyed by `(block, stage)`
rather than block alone, so the decision projection carries the stage and the routes take it. A block
may hold a live session per stage — the list must be able to carry two brainstorm decisions at once.

### B1 — `GET /api/v1/me` (key introspection) ⬜

There is no way for a caller to ask what its own key can do. Every `403 insufficient_scope` is
currently discovered by attempting the action. A two-field response (workspace id, scope) makes an
integration's startup self-check possible and costs one read. Small, and it pairs naturally with the
scope work above, since A1–A4 make scope more load-bearing.

### B2 — `GET /api/v1/openapi.json` ⬜

ADR 0030 already calls this "trivial once wanted — the spec already ships as a repo file, so an
endpoint is only packaging". It becomes materially more useful once A1–A4 widen the surface.

### C1 — Notification-webhook management under `/api/v1` ⬜

Managed today only over the session-authed `GET|PUT|DELETE /workspaces/:ws/notification-webhook`
behind `integrations.manage`, and there is deliberately no SPA panel. A deployment whose operator is
headless therefore has NO route to register the receiver that the run-lifecycle push exists to feed.
`admin` scope; the sealed signing secret must stay write-only (never readable back), and the
`runEvents` selector rides it.

### C2 — Step output on `GET /api/v1/tasks/:taskId/run` ⬜

`publicJob` carries a `result`; `publicRun` carries step states, the PR and the error, but no step
output. A board task running an inline-only pipeline (a spec-writer, say) therefore produces a
deliverable the API cannot read. Lowest priority of the set — the container pipelines that dominate
board work deliver through the PR — but worth doing if a consumer asks for inline board work.

## Considered and NOT recommended

Recorded so these are not re-proposed:

- **`since` / incremental polling on the task list.** Still not deliverable, re-verified against the
  Drizzle schema: `blocks` carries no `created_at` or `updated_at`. ADR 0030's reasoning stands
  unchanged — a real `since` means adding a timestamp column to the hottest table in the system, and
  it stays unbundled until a consumer asks for it.
- **The fork-decision CHAT.** Deliberately excluded by `headless-clarification-loop.md`: it is an
  interactive deliberation affordance, and a headless caller already receives each fork's full
  approach / trade-offs / risk text.
- **Recurring-pipeline schedules** (`/recurring-pipelines/*`). A headless caller driving the API has
  its own scheduler; exposing ours duplicates it and adds a second place for a schedule to fire from.
- **`POST /bootstrap`.** Unchanged from ADR 0030's Tier 4: container-backed and force-pushes to
  GitHub, breaking the "public runs never touch GitHub" invariant.
- **Per-step lifecycle webhook events.** ADR 0030 rejected this as a firehose; the SSE endpoints
  already serve a caller wanting step-level detail, bounded by their own poll.

## Gotchas any slice here inherits

- **No parallel logic, ever.** Every action delegates to the SAME service method the SPA controller
  calls, so the park's CAS / approval-id arbitration applies identically whichever surface answers
  first. Racing surfaces are already arbitrated; do not add locking.
- **Every response is the run's whole decision list**, not the one entity touched — the interesting
  outcome is what the run is NOW asking. Re-read the run AFTER acting.
- **Carry the RUN's initiator, not the caller's.** These routes accept a board task run, very likely
  started by a real user whose PAT the resumed container work needs
  (`runWithInitiator` / `PatPreferringAppRegistry`). "A headless caller has no user, so skip it" is
  wrong.
- **A parked run waits forever.** There is no decision timeout; do not design against one expiring.
- **`PublicDecisionController` keeps hand-built error envelopes on purpose** — failures are DATA
  there, so the contract handlers stay typed against their declared response schemas. Follow the
  existing shape rather than throwing a `DomainError`.
- **Scope placement.** A1–A4 are `decide`. C1 is `admin`. B1/B2 are `read`.
- **Regenerate `docs/openapi.json`** (`pnpm gen:openapi`) in the same PR, with the
  `COMPONENT_SCHEMAS` + `OPERATION_DOCS` entries each new named DTO needs; CI fails on drift.

## Open question for the maintainer

Should `POST /api/v1/tasks/:taskId/start` require `decide` when the resolved pipeline can park
(`canParkOnHuman`), matching the initiative surface? It is the smaller, more consistent rule, but it
is a **breaking change for existing `write` keys** that start gated board pipelines today — exactly
the kind of change ADR 0030 says to flag prominently. The alternative is to leave the start path
permissive and rely on A1–A4 making every park answerable, which removes the harm without taking
capability away from a live integration. Recommended: land A1–A4 first, then revisit, because the
answer is much cheaper once no park is a dead end.
