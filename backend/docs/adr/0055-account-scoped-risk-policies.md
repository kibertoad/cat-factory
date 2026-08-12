# ADR 0055: Account-scoped risk policies, inherited by every board

- Status: accepted
- Date: 2026-08-12
- Context layer: `@cat-factory/contracts` + kernel (ports + tier merge) + orchestration (risk
  policies, the board guards, the engine's resolution) + `@cat-factory/server` + both runtime
  facades + the SPA

Extends [ADR 0037](./0037-role-scoped-merge-policy.md) (what a risk policy decides),
[ADR 0053](./0053-unattended-run-autonomy.md) and [ADR 0054](./0054-per-scope-pipeline-defaults.md)
(the two per-scope defaults a board holds).

## Context

A risk policy is the most consequential piece of configuration a deployment holds: it decides what
lands without a person, which roles are sandboxed, which change classes are landable at all, and
whether a run answers its own quality parks. It was per-BOARD and only per-board, seeded from the
built-in catalog when the board was created.

For one board that is right. For an organisation it is the wrong unit twice over. An org that has
decided "nothing over 40% risk merges itself, and a member's runs never land a schema change" had to
author that on every board and keep every copy in step by hand, with nothing anywhere stating that
the copies were meant to agree. And there was no scope at which a platform owner could say it once:
the tier above the board existed for prompt fragments (ADR 0006), for skills, and for foundational
services (ADR 0031), but the setting with the largest blast radius had no account tier at all.

Everything the two shipped tiered libraries needed was therefore already in place, and the risk
policy library was the conspicuous omission.

## Decision

### An `account_risk_policies` table, merged under the board's own by id

A board's visible library is `account ⊕ workspace`, the board's own row winning a collision, and a
board may HIDE an inherited policy (`risk_policy_suppressions`). The precedence is one pure kernel
function, `mergeRiskPolicyTiers`, plus its single-id twin `resolveRiskPolicyTier`, and the two are
pinned to each other by a test that derives the second's expectation from the first.

That pairing is the load-bearing part. Three readers ask this question — the settings editor, every
picker (through the board snapshot), and the ENGINE resolving a task's pinned policy — and a
resolution that admitted an id the editor calls hidden, or refused one the picker offered, would
decide how much oversight a merge takes by a rule nobody can see. So every reader holds one
`WorkspaceRiskPolicyReader` (`WorkspaceRiskPolicyLibrary`), which is also why the two board guards
(`presetPinGuard`, `riskPolicySelectionGuard`) were re-typed rather than left on the workspace-tier
repository: a task must be allowed to pin what it is offered, and a move onto an inherited, wider
posture must be judged.

### Its own table, not a re-tiering of `merge_threshold_presets`

The sibling libraries key rows on an `(owner_kind, owner_id)` pair, and this one deliberately does
not, because the two tiers have different LIFECYCLES: a board row is seeded from the built-in catalog
at creation, carries the board's per-scope default claims, and is reclaimed by the board-delete
cascade. None of that is true of a shared account row.

The cascade is the concrete cost. It is driven by `DELETE ... WHERE workspace_id = ?` over one
authoritative table list (`WORKSPACE_SCOPED_TABLES`) with a completeness test behind it, and a table
keyed on `(owner_kind, owner_id)` cannot be in that list. Re-tiering would have traded a real
guarantee (a deleted board's policies go with it) for a uniformity that buys nothing at runtime,
since the merge reads the two tiers separately either way.

### The suppression is a narrow table, not a tombstone

The fragment and foundational-service libraries suppress by tombstoning a row at the suppressing
tier. That shape earns its place there by doing a SECOND job — marking a row removed upstream by a
repo sync — and it costs them a standing rule that a suppression must never win the merge as an empty
override (hence `hardDelete` rather than clearing `deleted_at`).

A risk policy has no upstream sync and ~20 NOT NULL numeric columns, so a tombstone here would mean
inventing ceilings for a row that exists only to be absent. One narrow table asserts exactly one
thing, un-hiding is a plain `DELETE`, and the hollow-override failure mode does not exist to guard
against.

### An account row holds NO default claim

`isDefault` / `isUnattendedDefault` are refused at the account write door (422) rather than stored.
Which policy governs a task that pinned none is a per-BOARD question: one account's boards routinely
want different postures, and there is no row an account could flag that would be right for all of
them. A board that wants an inherited posture as its default clones it and promotes the copy, which
is the same click and leaves a row the board owns.

Refused rather than silently dropped, because the request states an intent the tier cannot honour and
the caller would otherwise reload to find the flag missing with nothing explaining why.

### A clone gets a FRESH id

An override sharing the account's id reads as the same policy in every picker and on every task that
pinned it, so a board editing its copy would silently re-point work filed against the account's
posture. A new id moves nothing that already exists and says what it is. The clone also drops
`version`, so a copy of a policy that happens to carry a built-in id is never offered a reseed that
would overwrite it with catalog values it never came from.

### Hiding, and deleting, leave a dangling pin alone

A task that pinned a policy the board then hides (or an account then withdraws) falls back to that
board's default for the run's scope, exactly as a deleted local policy does. Refusing instead would
need a deployment-wide scan of every board's tasks and would leave an account unable to retire a
posture because one board once pinned it. The SPA confirms the hide for that reason: it is a change
of merge posture on existing work, not a change to a list.

## Rationale

**Why the account tier is member-editable, not admin-only.** It follows the account-tier fragment and
skill libraries, whose routes guard on account MEMBERSHIP. Holding this one library to a different bar
would be a rule with no stated reason, and the mothership machine token scopes accounts rather than
roles, so an admin-only HTTP guard would also have been weaker than it looked over the RPC.

**Why `getDefault` stayed a plain delegate.** It answers from the board tier alone, which is the whole
of the previous behaviour. Every existing board keeps resolving exactly the row it resolved before
this change, so a deployment that adds no account policy sees no behavioural difference anywhere.

**Why the editor renders an inherited policy as a SUMMARY.** A greyed-out copy of the form suggests
the numbers are a click away from editable, when the remedy is a different act entirely (clone, then
edit the copy). The summary is `RiskPolicyPreview`, the component the task picker already explains a
policy with, so what a policy MEANS is worded one way everywhere.

**Why the new account tab is not interface-mode gated.** Its siblings in the account panel are not,
and neither is the workspace "Merge thresholds" tab this mirrors; gating one tab of five would hide
the account half of a setting whose board half is listed right next to it.

## Consequences

- `GET /workspaces/:ws/risk-policies` and the board snapshot now answer the MERGED library, each entry
  carrying `tier`. `GET /api/v1/risk-policies` therefore lists inherited policies too, so a public
  caller can pin one; the public response SHAPE is unchanged (no OpenAPI version change), and a
  deployment with no account policies sees the same list it saw before.
- `PATCH` / `DELETE` of an inherited id answer `409` with `details.reason: 'risk_policy_inherited'`,
  and clone/hide of a board's own id answer `risk_policy_not_inherited`. Both are new
  `CONFLICT_REASONS` members with translated copy in all ten locales.
- `RiskPolicyRepository` gains a read-only supertype (`WorkspaceRiskPolicyReader`); the engine, both
  board guards and `resolveRiskPolicy` hold that instead of the repository. `RunMergePolicyDeps`,
  `ExecutionServiceDependencies` and the two guard factories renamed the field to `riskPolicyReader`.
- Two new tables on both facades (D1 migration 0092 ⇄ a Drizzle migration), two new kernel ports, and
  a run-level conformance group asserting the tier merge, the collision precedence, suppression and
  its undo, the clone, cross-account isolation and an inherited PIN resolving.
- A facade that wires neither new repository is a pass-through: nothing is inherited, nothing is
  hidden, and every read answers exactly the board's own rows.
