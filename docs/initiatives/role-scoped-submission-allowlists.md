# Initiative: role-scoped submission allowlists per change class

**Status:** planned (design settled; no slices landed) · **Owner:** core · **Started:** 2026-08-04

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

[ADR 0037](../../backend/docs/adr/0037-role-scoped-merge-policy.md) gave a workspace two ways to
hold a non-engineer's runs short of landing code, and there is a gap exactly between them.

- **`classRulesByRole` with `never`** routes a class to a human. But the merge route carries no
  permission gate of its own beyond the RBAC viewer write floor (`>= member`), which is the gap
  the ADR itself names: a member starts a run, receives the `merge_review` card their own run
  raised, taps merge, and it lands. No second person was involved at any point.
- **`dryRunRoles`** closes that, because a sandboxed run is refused at BOTH exits. But it is
  all-or-nothing: every class that role touches, or none.

So a workspace cannot say the thing it most often wants to say: **"a product manager may land copy
and dependency bumps on this service, and may not land source, however good the scores look."**
Today that forces a choice between sandboxing their whole workflow (they stop being useful) and
trusting them with `source` behind a review card only they will read.

End state: a per-role ALLOWLIST of change classes a preset will land at all, composing with both
existing settings and refused at the same two exits `dry_run` is.

## Target pattern

1. **An ALLOWLIST, not a denylist**, in `@cat-factory/contracts` beside its two siblings
   (`submissionClassesByRoleSchema`: a strict partial map role → `RuleableChangeClass[]`). The
   safety property is the same one `narrowMergeClassRule` has: a class nobody thought about is
   OUTSIDE the list, so a class added to the vocabulary in a later release is refused for a scoped
   role rather than silently landed by it.
2. **Absent means UNRESTRICTED, not empty.** Silence is not an empty allowlist, exactly as it is
   not a `thresholds` rule in `classRulesByRole` ("absent is not a rule", ADR 0037). Only a role
   somebody wrote an entry for is scoped, so `{}` stays the identity the wire contract says it is.
3. **`unknown` is INERT — never refused.** An unreadable diff must not sandbox a run that would
   otherwise have landed, the same reading `resolveMergeClassRule` takes: a VCS outage cannot
   change policy. Note this is the OPPOSITE direction from rule 1, and deliberately so.
4. **A run with no pinned role matches no entry**, exactly as `dryRunForcedForRole` reads one.
5. **Refused at BOTH exits**, which is what makes it different from `never`: the auto-merge arm in
   `MergeResolver`, and `StepDecisionController`'s manual merge guard beside `assertNotDryRun`,
   with its own conflict reason rather than a borrowed `dry_run_not_mergeable` (the two have
   different remedies, and copy that says "re-run it live" would be a lie here).

## Prioritized checklist

| #   | Slice                                                                                                    | Status  | PR  |
| --- | -------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | `submissionClassesByRoleSchema` + `submissionAllowedForRole` in contracts, with unit tests               | ⬜ todo |     |
| 2   | Persistence: `submission_classes_by_role` column (D1 migration ⇄ Drizzle + `db:generate`), both repos    | ⬜ todo |     |
| 3   | `RiskPolicyService` + `catalog.ts` defaults (EMPTY on every built-in, so the default is unchanged)       | ⬜ todo |     |
| 4   | `MergeResolver`: the auto-merge refusal + its recorded reason on the decision                            | ⬜ todo |     |
| 5   | `StepDecisionController.assertSubmissionAllowed`, beside `assertNotDryRun`, with its own conflict reason | ⬜ todo |     |
| 6   | SPA preset editor (per-role class allowlist) + the refusal copy, i18n across all locales                 | ⬜ todo |     |
| 7   | Cross-runtime conformance: allowed lands, disallowed is refused at BOTH exits, `unknown` still lands     | ⬜ todo |     |

## Conventions & gotchas

- **The class is only known at MERGER SETTLEMENT**, not at start. `MergeTrackRecordService.classify`
  derives it from the PR's changed files, so this cannot be an admission-time refusal the way
  `dryRunRoles` is: the PR is already open by the time the class exists. That is not a defect —
  the pull request opening is not the harm; the platform LANDING it is. Say so in the refusal copy,
  which must not claim the change cannot land at all (a human with write access on the host can
  always merge it there, exactly as the `dry_run` copy already concedes).
- **The manual-merge guard needs the class too**, and the cheapest correct source is the same
  `classify` call the resolver makes (one VCS call, swallowed to `unknown` on failure). Reading it
  back off the recorded decision would be one fewer call, but a decision may not exist yet on every
  path that reaches the merge route.
- **Do NOT fold this into `dryRunRoles` by widening that field.** The two answer different
  questions and compose: a role in `dryRunRoles` is sandboxed for everything and never consults an
  allowlist; a role with an allowlist is sandboxed per class. Merging them would make the narrower
  setting unable to express the broader one without listing every class.
- **`classRulesByRole` and this are ORTHOGONAL, and both apply.** A class may be `always` under the
  role's class rules and still outside its submission allowlist, and the allowlist wins — it is a
  bar on landing at all, where the class rule only decides how much review landing takes. The
  precedence ladder in `MergeResolver` therefore gains an arm ABOVE `autoMergeEnabled` and beside
  `dry_run`, for the same reason `dry_run` sits there: it is a property of who started the run
  rather than of the policy, and no preset can consent on their behalf.
- **Every built-in preset ships it EMPTY**, so the default is byte-for-byte the historical
  behaviour, matching how `dryRunRoles` and `classRulesByRole` landed.
