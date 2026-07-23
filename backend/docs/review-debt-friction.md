# Review-debt friction (opt-in) — design

**Status:** Implemented (see the "Landed code" map at the end).
**Scope:** per-workspace, opt-in, off by default.

## Problem

The platform's pipelines deliberately park runs on human judgement: a `merge_review`
notification when the merger's assessment exceeds the task's threshold preset, a
`pipeline_complete` confirm when a pipeline has no merger, the `human-review` PR gate,
requirements/clarity reviews, fork decisions, human-test and visual-confirmation gates,
follow-up approvals. Runs **wait indefinitely** by design — the old hard decision timeout
was replaced by the notification-severity escalation (`waitingEscalationMinutes`, see
`escalateStaleNotifications`), which turns an overdue card red but changes nothing else.

In practice teams keep **authoring new tasks while the review queue grows**. Nothing in
the product connects "you are creating more work" to "you have finished work nobody has
looked at", so review debt accumulates silently: parked runs hold branches that go stale
(inviting `conflicts`-gate churn), reviewers context-switch onto ever-older diffs, and the
board fills with `pr_ready`/blocked tasks that are one click from done. The red inbox card
is a passive signal; it competes with the much stronger pull of starting something new.

This design adds an **opt-in friction mechanism at the point of task creation**: when the
workspace has too many tasks stuck waiting on human review — by count, or by how long the
oldest has been stuck — creating a new task requires an explicit acknowledgement (soft
friction), and past a harder threshold is refused outright (hard block) until the review
queue is worked down.

## Goals

- Make review debt **visible and costly at the moment it grows** (task creation), not only
  in the notifications inbox.
- **Opt-in per workspace**, off by default, tunable by workspace admins. Zero behaviour
  change for workspaces that don't enable it.
- Two escalation tiers: **soft friction** (confirm-to-proceed, listing exactly what is
  waiting) and a **hard block** (creation refused) on either of two triggers — total count
  of tasks in human review, or any task stuck in human review longer than a configured age.
- Enforced **server-side** (the SPA cannot be the only gate), with the same verdict
  computable client-side for progressive pre-warning.
- Runtime-symmetric (D1 ⇄ Drizzle) with conformance coverage, per the repo's parity rule.

## Non-goals

- **No auto-actions on the debt itself.** This feature never merges, dismisses, escalates,
  or times out a waiting run — that remains the human's job (and the existing severity
  escalation's signal). Friction only shapes _new_ work.
- **Not a run-start gate.** `RunAdmission` already owns start-time admission
  (`assertWithinTaskLimit`, dependency and budget gates). Extending the same verdict to
  run start is a listed possible extension, not part of this design — the user-visible
  problem is authoring new work, and gating starts would double-punish tasks that already
  exist.
- **No per-user accounting.** Debt is workspace-scoped; we do not track which engineer
  owes which review (the platform has no review-assignment model to hang that on).
- **No new "review phase" state machine.** The definition below reuses the existing
  open-notification signal rather than introducing a parallel notion of "in review".

## What counts as "a task stuck in human review"

The single existing, already-battle-tested signal for "a run is waiting on a human" is the
**open notification**: every human-parking surface raises one (`merge_review`,
`pipeline_complete`, `requirement_review`, `clarity_review`, `decision_required`,
`human_test_ready`, `visual_confirmation_ready`, `human_review`, `followup_pending`,
`fork_decision_pending`, `pr_review_ready`), each carrying `blockId`, `createdAt`, and
`status` (`open` until acted/dismissed). The severity-escalation sweep already interprets
"open card older than the workspace threshold" as "a human is overdue" — this design
reuses exactly that interpretation rather than inventing a second one.

**Definition.** A task is _in human review_ iff it has at least one **open** notification
whose type is in a new closed constant `REVIEW_WAIT_NOTIFICATION_TYPES`
(`@cat-factory/contracts`, alongside `notificationTypeSchema`):

```
merge_review, pipeline_complete, requirement_review, clarity_review,
decision_required, human_test_ready, visual_confirmation_ready,
human_review, followup_pending, fork_decision_pending, pr_review_ready
```

Deliberately **excluded**:

- Failure-remediation cards (`ci_failed`, `test_failed`, `release_regression`) — those are
  "the machine needs help", not "a human owes a review"; counting them would punish teams
  for flaky CI rather than slow reviewing.
- Block-less/system cards (`platform_health`, `budget_paused`, `key_drift`, `initiative`)
  — not tied to a reviewable task at all.

Rules on top of the raw rows:

- **Deduplicate per `blockId`.** One task = one unit of debt no matter how many open cards
  it holds (a task can have e.g. a `pr_review_ready` and a `followup_pending` at once).
- **Age** of a debt item = `now - min(createdAt)` over its open review-wait cards — the
  moment the task _first_ started waiting in its current park.
- **Dismissal clears debt.** Dismissing a card is a deliberate human decision ("we are not
  going to act on this"), and the existing lifecycle already treats it as terminal. No
  special casing.
- The constant is a **closed contracts-level set**, so the frontend, the pure logic, and
  the backend share one source of truth (the `ConflictReason` pattern), and adding a new
  human-parking surface to the debt definition is a one-line change reviewed like any
  other contract change.

Why not derive it from execution state (parked steps / `pr_ready` blocks) instead? The
run's `blocked` status conflates human parks with other waits, `pr_ready` misses mid-run
parks (requirements review is the _first_ step), and reconstructing "when did it start
waiting" would need new persisted state. The notification row already has the right
scope, the right timestamp, the right lifecycle, and batched reads
(`NotificationRepository.listOpen`) on both runtimes.

## Settings model

Four new fields on `workspaceSettingsSchema` (`@cat-factory/contracts`,
`workspace-settings.ts`), following the `taskLimitMode` shape (a mode picklist + nullable
numeric knobs, `null` = dimension disabled):

```ts
/** Whether/how review-debt friction is applied to task creation.
 *  - `off`     — no friction (the default).
 *  - `warn`    — soft friction only: past the warn threshold, creating a task
 *                requires an explicit acknowledgement.
 *  - `enforce` — soft friction plus the hard block thresholds. */
reviewFrictionMode: v.picklist(['off', 'warn', 'enforce'])

/** Tasks-in-review count at which soft friction starts. Default 3. */
reviewFrictionWarnCount: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))

/** Hard block: refuse task creation while ≥ this many tasks are in human review.
 *  Null ⇒ the count trigger is off. Must be ≥ reviewFrictionWarnCount. */
reviewFrictionBlockCount: v.nullable(limitSchema)

/** Hard block: refuse task creation while ANY task has been in human review longer
 *  than this many minutes. Null ⇒ the age trigger is off. */
reviewFrictionBlockStuckMinutes: v.nullable(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
)
```

- Defaults (in `DEFAULT_WORKSPACE_SETTINGS`, kernel `catalog.ts`): `mode: 'off'`,
  `warnCount: 3`, `blockCount: null`, `blockStuckMinutes: null` — fully inert until an
  admin opts in.
- Write-time validation (in `WorkspaceSettingsService.update`, like the existing
  `taskLimit` cross-field checks): `enforce` requires at least one of
  `blockCount`/`blockStuckMinutes` non-null; `blockCount >= warnCount` when both set.
- The **age trigger is independent of the count trigger** on purpose: "only two tasks are
  waiting, but one has waited four days" is exactly the pathology the requester named, and
  a count threshold alone never fires on it.
- The settings are edited through the existing `PATCH /workspaces/:ws/settings`
  (`updateWorkspaceSettingsSchema` gains the same four optional fields) behind the
  existing admin-tier settings permission — no new routes, no new RBAC surface.

## The verdict — one pure function, shared

A pure function in `@cat-factory/contracts` (new `reviewFriction.ts`, colocated with the
type constant — the `frameAllowsVisualPipeline` precedent, which `RunAdmission` imports
from contracts today):

```ts
export interface ReviewDebtItem {
  blockId: string
  /** Epoch ms the task first started waiting (min createdAt over its open cards). */
  waitingSince: number
}

export type ReviewFrictionVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; debt: ReviewDebtItem[] }
  | { kind: 'block'; reason: 'count' | 'stuck'; debt: ReviewDebtItem[] }

export function assessReviewFriction(
  openNotifications: readonly Pick<Notification, 'type' | 'status' | 'blockId' | 'createdAt'>[],
  settings: Pick<
    WorkspaceSettings,
    | 'reviewFrictionMode'
    | 'reviewFrictionWarnCount'
    | 'reviewFrictionBlockCount'
    | 'reviewFrictionBlockStuckMinutes'
  >,
  now: number,
): ReviewFrictionVerdict
```

Semantics, in precedence order:

1. `mode === 'off'` → `ok`.
2. Build the deduplicated debt list from `REVIEW_WAIT_NOTIFICATION_TYPES` as defined above.
3. `mode === 'enforce'` and `blockStuckMinutes` set and any item's age exceeds it →
   `block { reason: 'stuck' }` (age wins over count so the error names the _actual_ worst
   offender).
4. `mode === 'enforce'` and `blockCount` set and `debt.length >= blockCount` →
   `block { reason: 'count' }`.
5. `debt.length >= warnCount` → `warn`.
6. Otherwise `ok`.

Living in contracts means the SPA computes the identical verdict from the snapshot it
already has (the workspace snapshot carries the open notifications), so the "Add task"
affordance can pre-warn **without any new endpoint** — and the server-side check can never
disagree with what the UI showed.

## Enforcement point

**`BoardService.addTask`** — the human task-authoring path (`addTaskContract`, the board
controller). Before creating the block:

```
settings  = workspaceSettingsService.get(workspaceId)        // cached slice, 1 read
open      = notificationService.listOpen(workspaceId)        // 1 batched read
verdict   = assessReviewFriction(open, settings, now)
```

- `block` → throw `ConflictError` (→ 409, the standard toast/modal path) with a
  machine-readable reason:
  - `review_debt_blocked` with details
    `{ reason: 'count' | 'stuck', debt: [{ blockId, title, waitingMinutes }], threshold }`.
    Titles are joined in from the workspace block list the service already loads for
    parent validation — no extra query, no N+1.
- `warn` → throw `ConflictError` with reason `review_debt_warn` and the same details,
  **unless** the request carries the new optional body field
  `acknowledgeReviewDebt: true` (added to `addTaskSchema`). The SPA turns the 409 into
  the friction dialog (below) and retries with the flag once the human confirms. The
  server re-evaluates on the retry, so an acknowledgement can never tunnel through a
  _hard_ verdict that raced in between (hard is checked first and ignores the flag).
- `ok` → create as today.

Both service dependencies are **optional seams** (the `RunAdmission` convention): when the
notifications or settings module isn't wired (tests, conformance harnesses, minimal
facades), the guard is a pass-through and every existing test runs unchanged.

Deliberately **not** gated:

- **Non-task blocks** (frames, modules, epics, initiatives) — structure, not work items.
- **Engine-internal creation** (`BoardService.createInternalTask` — initiative-loop
  spawns, bug-triage follow-ups, blueprint reconciliation): friction targets a _human
  choosing to author new work_; silently breaking the engine's own follow-up spawning
  would corrupt running flows, and those tasks are consequences of work already admitted.
- **Recurring pipelines** run existing blocks, not new ones — no interaction.
- **No admin bypass.** Admins feel the same friction; their escape hatch is editing the
  settings (a deliberate, auditable act), not a silent exemption that would undercut the
  point of the feature for exactly the people most able to ignore it.

TOCTOU note: the verdict is computed at request time and not transactional with the
insert. That is acceptable — this is a behavioural friction device, not a correctness
invariant (same stance as the task-limit gate).

## Frontend

- **Settings** — a "Review friction" group in `WorkspaceSettingsPanel.vue` next to the
  task-limit controls: mode select, warn count, and the two hard-block knobs (enabled only
  in `enforce` mode). All copy through i18n (`settings.reviewFriction.*`).
- **Friction dialog** — a dedicated modal (new `ReviewFrictionDialog.vue`) opened when
  task creation returns a `review_debt_warn` / `review_debt_blocked` 409:
  - Lists the waiting tasks (title, how long each has waited, worst first), each row
    deep-linking to the block / its open notification so "go review instead" is one click.
  - `warn`: primary action **"Go review"**, secondary **"Create anyway"** (retries with
    `acknowledgeReviewDebt: true`). The ordering is the friction.
  - `blocked`: only **"Go review"** (plus close). The body names the trigger ("more than
    N tasks waiting" / "a task has waited longer than X").
- **Pre-warning (progressive)** — the Add-task affordance runs `assessReviewFriction`
  against the snapshot's open notifications and shows a small debt badge when the verdict
  isn't `ok`, so the dialog is rarely a surprise. Server remains the authority.
- Error-code → message mapping follows the `usePipelineErrorToast` pattern: the reasons
  join the contracts `ConflictReason` vocabulary, keys under `errors.reviewFriction.*`,
  with the exhaustive-`Record` drift guard.
- Locale parity: all new keys land in every locale in the same PR, per the i18n rules.

## Persistence & parity

- Four new columns on `workspace_settings`, mirrored on both runtimes:
  - D1: a new numbered migration (`ALTER TABLE workspace_settings ADD COLUMN
review_friction_mode TEXT NOT NULL DEFAULT 'off'`, `review_friction_warn_count
INTEGER NOT NULL DEFAULT 3`, `review_friction_block_count INTEGER`,
    `review_friction_block_stuck_minutes INTEGER`) — the `0012_store_agent_context.sql`
    shape.
  - Node: the same fields on the Drizzle `workspaceSettings` table in `db/schema.ts` +
    a `pnpm db:generate` migration.
- No new tables, no new repositories, no backfill (defaults make existing rows valid;
  backwards compatibility is a non-goal regardless).
- Reads ride the existing settings cache slice; **no invalidation changes** (the settings
  write path already invalidates it).

## Testing

- **Pure logic** (contracts): table-driven tests for `assessReviewFriction` — dedup across
  multiple cards per block, age computed from the oldest card, excluded types ignored,
  precedence (stuck > count > warn), null-knob dimensions off, boundary values.
- **Service** (orchestration): `BoardService.addTask` tests for pass-through when seams
  are unwired, 409 shapes for warn/block, acknowledge flag honored for warn and ignored
  for block, `createInternalTask` exempt.
- **Cross-runtime conformance**: a `defineReviewFrictionSuite` slice — seed settings via
  the settings route, raise a parking notification through the engine (the existing
  fake-executor decision path), assert the task-create 409 on **both** facades so a facade
  that forgot the settings columns or the guard wiring fails a test instead of shipping.
- **E2E** (optional, follow-up): warn dialog round-trip on the live board — only if it can
  be asserted through pushed UI updates per the e2e rules.

## Implementation plan (one PR, or two small ones)

1. Contracts: `REVIEW_WAIT_NOTIFICATION_TYPES`, `assessReviewFriction` + types, settings
   schema fields, `acknowledgeReviewDebt` on `addTaskSchema`, conflict reasons.
2. Kernel: defaults in `DEFAULT_WORKSPACE_SETTINGS`.
3. Orchestration: settings write-validation; the `addTask` guard.
4. Runtimes: D1 migration ⇄ Drizzle schema + migration; settings repo column mapping.
5. Conformance slice; unit tests.
6. Frontend: settings panel group, friction dialog, pre-warn badge, i18n (all locales).
7. Docs sweep: this document gains links to the landed code; `CLAUDE.md` gets a pointer if
   the flow proves non-obvious; changesets for every touched versioned package.

## Alternatives considered

- **Gate run _start_ instead of task creation.** Rejected as the primary lever: the ask is
  friction on authoring new work; start-gating punishes tasks that already exist and
  interleaves badly with retries/restarts (which deliberately skip start-only gates).
  Cheap to add later as one more `RunAdmission` start-only guard reusing the same verdict.
- **Derive debt from execution/step state.** Rejected — see the definition section:
  conflates non-human waits, misses mid-run parks, and lacks a "waiting since" timestamp
  without new persisted state.
- **Auto-escalating friction (e.g. growing cooldown timers).** Rejected: opaque, hostile,
  and unnecessary once a hard block exists; the two-tier model is legible.
- **Account-level or per-service scoping.** Workspace scope matches every existing policy
  knob (`taskLimitMode`, spend budget, `waitingEscalationMinutes`); per-service scoping
  can be layered on later exactly the way `taskLimitPerType` layered onto the shared cap,
  if a real need appears.
- **A standing "review debt" banner instead of creation-time friction.** Passive signals
  already exist (the red inbox). The point of this feature is to attach the cost to the
  action that grows the debt.

## Landed code

The implementation follows this design; the notable pieces:

- **Contracts** (`backend/packages/contracts/src/`): `REVIEW_WAIT_NOTIFICATION_TYPES` +
  `isReviewWaitNotificationType` (`notifications.ts`); the pure `assessReviewFriction` /
  `collectReviewDebt` + `ReviewDebtItem` / `ReviewFrictionVerdict` (`reviewFriction.ts`, with
  `reviewFriction.test.ts`); the four `reviewFriction*` fields on `workspaceSettingsSchema` +
  `updateWorkspaceSettingsSchema` (`workspace-settings.ts`); `acknowledgeReviewDebt` on
  `addTaskSchema` (`requests.ts`); the `review_debt_warn` / `review_debt_blocked` conflict
  reasons (`errors.ts`).
- **Kernel**: defaults in `DEFAULT_WORKSPACE_SETTINGS` (`domain/catalog.ts`).
- **Orchestration**: the `addTask` guard `assertReviewFrictionAllows` + its 409 builder, behind the
  optional `reviewFrictionSettings` / `reviewFrictionNotifications` seams
  (`modules/board/BoardService.ts`, wired in `container.ts`); the `enforce`-mode cross-field
  write validation (`modules/settings/WorkspaceSettingsService.ts`). Tests:
  `BoardService.reviewFriction.test.ts`.
- **Runtimes**: D1 migration `0058_review_friction.sql` + `D1WorkspaceSettingsRepository`;
  Drizzle `workspaceSettings` columns + generated migration + `DrizzleWorkspaceSettingsRepository`.
- **Conformance**: `defineReviewFrictionSuite` (HTTP-driven) run on all three facades, plus the
  four fields added to `defineWorkspaceSettingsSuite`'s round-trip.
- **Frontend** (`frontend/app`): the "Review friction" group in `WorkspaceSettingsPanel.vue`, the
  `ReviewFrictionDialog.vue` modal + the add-task 409 retry flow, the pre-warn badge, and the
  `errors.reviewFriction.*` / `settings.reviewFriction.*` i18n keys (all locales), with the
  `usePipelineErrorToast`-style exhaustive conflict-reason map.

## Open questions

- Should `test_failed` count as review debt? It has a human-actionable retry but is
  failure-shaped; the design says no. Revisit with real usage data.
- Should the warn tier record acknowledgements (who created past the warning, how often)?
  Trivially derivable later from an audit log; not designed in now.
- Whether `enforce` should also dim/annotate the board's "add" affordances pre-emptively
  everywhere (beyond the badge) is a UX call to make with a prototype.
