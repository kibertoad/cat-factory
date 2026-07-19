---
'@cat-factory/app': minor
---

Complete modular-vue slice 5 (agent-run window chrome → `ResultWindowShell`): convert
the final nine result windows behind the shared shell and remove the last of the
per-window modal chrome. `PrReviewWindow`, `ClarityReviewWindow`, `BrainstormWindow`,
`RequirementsReviewWindow`, `InitiativeTrackerWindow`, `InitiativePlanningWindow`,
`ServiceSpecWindow`, `ConsensusSessionWindow`, and `DocInterviewWindow` are now
body-only markup wrapped in `ResultWindowShell`, so all 18 windows share one dialog
shell (chrome + the upstream `useModalBehavior` shared overlay stack).

Each window's specific header content moves to the shell's `#header-extras` slot —
iteration badges (clarity / brainstorm / requirements), status badges (initiative
planning / consensus / doc interview), the initiative tracker's progress bar + status
pair, the PR-review "Open PR" link, and the service-spec structured/Gherkin view
toggle. Preserved `data-testid`s (`pr-review-window`, `initiative-tracker-window`,
`initiative-planning-window`, `doc-interview-window`) move from the old backdrop to the
shell dialog, so existing e2e selectors are unaffected. `RequirementsReviewWindow` (the
only genuine step-result window in the batch) surfaces the shared restart control via
the shell's `stepRef`; the block-keyed windows omit it, exactly as `ForkDecisionWindow`
did. `ConsensusSessionWindow`'s structured header becomes two computed strings feeding
the shell's `title`/`subtitle`. The pick-one selection stays the slice-2
`resolveComponentRegistry` in `StepResultViewHost`, so there are no host or registry
changes.

Final cleanup (now that every window is on the shell): `useResultView` no longer
registers a per-window global Escape listener, and its `manageEscape` option is
removed — the shell owns Escape for all windows via `useModalBehavior`, so a second
listener would double-fire close. Every caller drops `manageEscape: false`.

e2e: the `initiative-checkpoint` spec now asserts the block-keyed
`initiative-tracker-window` renders in the shell (its `#header-extras` progress chip)
and closes on the shell-owned Escape then reopens — covering the shell chrome for a
block-keyed window after `useResultView`'s listener was removed.

Progress + per-window outcomes tracked in
`docs/initiatives/modular-vue-slice5-progress.md`.
