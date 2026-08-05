# ADR 0038: Per-step gate configuration

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/gates`, `@cat-factory/orchestration`, `@cat-factory/server`, both runtime
  facades) + the SPA (`@cat-factory/app`)

Supersedes the `extensible-custom-gate-config` initiative tracker, whose committed scope is
complete.

## Context

A pipeline's human checkpoints were a bare `Pipeline.gates: boolean[]`. A step either paused for
"a human" or it did not, and there was nowhere to say WHICH humans, HOW MANY of them, or what a
registered gate's own knobs should be for THIS step.

That left two separate gaps.

**The human gate had no policy.** A release step and a copy-tweak step got the same checkpoint:
one approval, from anyone the board admits to write. A workspace that wanted "only an admin may
clear the deploy gate" or "this one needs two people" had no way to express it, and no way for the
platform to enforce it if it had.

**A registered gate's parameters had to be hard-coded.** The built-in gates read their attempt
budget and time windows off the task's MERGE PRESET, which is the right grain for a workspace-wide
policy and the wrong one for "this pipeline's CI gate gets three rounds". A deployment registering
its own gate through `registerGate` had it worse: its knobs had nowhere to live at all, short of
adding a field to `RiskPolicy` — the platform learning about a gate it does not ship.

## Decision

One per-step `gateConfig`, on the extensible `StepOptions` bag
(`stepOptions[i].gateConfig`, [pipeline-step-options](../../docs/initiatives/pipeline-step-options.md)),
so it needs no column and no migration on either runtime. `gates[i]` stays the answer to "is there
a human checkpoint here"; `gateConfig` carries everything that checkpoint needs in order to be more
specific than "a human".

It has two halves, and the split is the decision:

- **The platform-enforced half** — `approvers` (workspace roles and/or named users) and
  `minApprovals`. Typed in `@cat-factory/contracts` because the backend ENFORCES it and the SPA
  RENDERS it, so both have to agree about what an approver set means.
- **The gate-declared half** — `fields`, validated against the descriptor form the gate itself
  registered (`GateRegistry.register(kind, factory, { configFields })`). The platform learns
  nothing about it: one declaration drives the save-time validation, the run-start re-validation
  and the authoring form the SPA renders.

### The approval policy

`GateApproverPolicy` narrows the MEMBER tier; it never widens anything. A viewer still cannot
resolve a gate (the RBAC write floor refuses the request before the policy is consulted), and a
workspace `admin` is always permitted regardless of what the policy lists — an admin can cancel the
run or edit the pipeline outright, so refusing them would buy no safety and would deadlock a gate
whose named approvers have left the board.

A machine key and an unattributed (auth-disabled) caller are refused by ANY policy. A shared
credential is not one of the people a policy named, and the honest answer is that such a gate needs
a person. This is additive: a gate with no policy behaves exactly as it always did, key callers
included.

The policy governs all THREE resolutions — approve, request changes and reject. A policy that let a
non-approver reject would be gating nothing; it would only be choosing which button the wrong
person presses.

### The quorum

`minApprovals` counts DISTINCT identities. Each approval is recorded on the gate
(`StepApproval.approvals`), a second approval from the same identity replaces the first rather than
counting twice, and the gate stays `pending` (the run stays parked) until the count is reached.

A quorum votes on ONE artifact, so only the approval that CLEARS the gate may carry a `proposal`
edit. An edit landing on an earlier approval would rewrite the text under the people already
counted toward the bar and the ones still to come, leaving every recorded approval standing against
something its approver never saw, and the next editor would overwrite it again. Refused rather than
accepted-and-misleading (`proposal_not_editable_until_quorum`, the sibling of the `outputIsRendered`
refusal); the reviewer's route is a plain approve, or request-changes, which re-runs the step with
the correction as feedback. The SPA withholds the affordance and says why, rather than letting the
button vanish.

Both the bar and the policy are SNAPSHOTTED onto the approval when the gate is raised, by the ONE
`buildStepApproval` builder every raise site goes through. Two settle paths raise this same
checkpoint: the ordinary step settle (`RunDispatcher`) and a gated COMPANION's settle
(`CompanionController`, which raises it on the producer's output once the companion has cleared
it). While each built its own object literal they did not stay in step: a raise with no
`approverPolicy` reads as "anyone entitled to write" and one with no `requiredApprovals` as a
quorum of one, so the divergence failed OPEN and silently: a configured companion gate saved
without complaint and resolved as though it had been configured with nothing. The builder is the
fix; a source-level test refuses a hand-rolled literal so a third raiser cannot drift the same way.

The snapshot is never re-read from the pipeline at approve time: the definition stays editable while a run is parked on
it, and a bar that moved under the people already counted toward it is a bar nobody agreed to. Same
reasoning as pinning a run's initiator role at admission (ADR 0037).

### The gate-declared parameters

`GateRegistration.configFields` is a `DescriptorField[]`, the repo's existing descriptor-form
vocabulary, rather than a gate-only schema language. So a gate's config form is collected,
validated, frozen and rendered by exactly the machinery an initiative preset's form and a custom
task type's brief already use — including `DescriptorFields.vue`, which gives a deployment's own
gate an authoring form from its registration alone.

The declaration lives on the REGISTRATION rather than on the `GateDefinition`, because the boundary
that needs it most (pipeline save) has no `GateContext` to build a definition with.

The validated values are copied onto `step.gate.config` once on first entry, so `probe` reads the
gate's knobs off the STEP with no new plumbing per parameter, and `attemptBudget(preset, config)`
lets the GATE decide how its own budget is overridden. The engine has no business knowing that one
gate calls its budget `maxAttempts` and the next one does not — which is the hard-coding this
exists to stop.

The built-ins dogfood it: `ci` / `conflicts` / `doc-quality` declare `maxAttempts`,
`post-release-health` adds `watchWindowMinutes`, and `human-review` declares `graceMinutes` (but
deliberately NO attempt budget: it waits for a person indefinitely by design, so a per-step cap
would be a deadline on a human review that nothing else in the gate expects).

## Rationale

**Why `StepOptions` rather than a new index-aligned array.** The proposal originally sketched a
`gateConfig?: Record<string, unknown>[]` beside `gates`. Every per-step knob that took that route
cost a contract array, a column in both runtimes, mapper lines, a builder array and a
run-construction copy line; `pipeline-step-options.md` exists to stop it. A field on the bag needs
none of them.

**Why numeric bounds moved into the shared descriptor vocabulary.** `DescriptorField` could bound a
string's length but not a number's range, so a gate's `maxAttempts` could only have been bounded by
the reader clamping it. A clamp turns a configuration mistake into behaviour nobody asked for and
nobody is told about, so `min`/`max` were added to the shared field shape and are enforced where
the value is FROZEN — which is also the only place that binds a value filled over the API.

**Why the refusals are save-time.** Three shapes are rejected at pipeline save and again at run
start: an approver policy on a step with no approval gate (a checkpoint that silently does not
exist), a quorum larger than the set of people who could reach it (a run that parks forever), and a
parameter no registered gate declares (a setting nobody reads). Each is silent at runtime and loud
at authoring time, so that is where they are refused.

**Why the shared rules live in contracts, not kernel.** The SPA has to AGREE about who may resolve
a gate, not merely consume the answer: it disables the buttons and renders the tally. A rule the
SPA cannot import is a rule the SPA reimplements, and the two then drift into a button that is
enabled for a request the server refuses.

## Consequences

- **A quorum needs identities to count.** On a deployment running with auth disabled every caller
  is the same `unattributed` actor, occupying one quorum slot, so `minApprovals: 2` can never be
  met there. That is the honest reading of the configuration, not a bug to paper over; the
  builder's control is available regardless, since a deployment turns auth on without re-authoring
  its pipelines.
- **A public-API caller can hold a gate open.** An `approve` that records a vote without reaching
  the quorum returns 200 and leaves the run parked, which is why
  `publicApprovalGateDecisionSchema` now projects `requiredApprovals` and `recordedApprovals` (the
  COUNT, named apart from the internal `StepApproval.approvals` LIST it counts). Without the
  tally an integration could not tell a recorded approval from a call that failed. Additive to the
  public surface (ADR 0034): new response fields, no behaviour change for a gate with no config.
- **Named approvers are workspace user ids**, so a policy does not survive being cloned into a
  different account's workspace in any meaningful way. The gate still functions (an admin can
  always resolve it); the named half simply matches nobody.
- **Retiring a declared field is a data question, not just a code one.** Values already frozen in
  `step_options` outlive the declaration, and `validateDescriptorFields` refuses an undeclared key
  — so removing a field from a gate's `configFields` makes the pipelines that set it fail to save
  until the key is dropped. Keep the field and ignore it, or migrate the rows.
