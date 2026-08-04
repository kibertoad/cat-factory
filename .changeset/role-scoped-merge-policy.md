---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Couple workspace RBAC to the per-class merge rules, and add a sandboxed run mode.

A merge preset now carries `classRulesByRole` — the per-change-class auto-merge rules narrowed by
the workspace role the run's initiator held — and `dryRunRoles`, the roles whose runs are forced
into dry-run mode: the pipeline runs in full and opens its pull request, but nothing merges. A run
can also request `mode: 'dry_run'` at start. Both settings default empty, so every existing preset
resolves to exactly its previous behaviour.

Narrowing is subtractive by construction: a role entry can make a class stricter than the base
rules but can never widen one, so a role allowlist is reviewable on its own and no preset edit can
turn one into a privilege grant. A role that authored nothing for a class, and a run with no role to
pin at all (a schedule fire, a public-API start, auth-disabled dev), both fall through to the base
rules rather than being treated as a tier.

The initiator's role and the run's mode are PINNED on the run at admission rather than re-resolved
at merge time: the merge settles on the durable driver's path, which has no request context to
resolve a role from, and a preset edited mid-run must not retroactively re-govern a run already in
flight. The sandbox is enforced at both exits — the auto-merge and the manual merge endpoint, which
refuses a dry run's PR with a new `dry_run_not_mergeable` conflict reason, since the review card the
first one raises is itself a merge button.

Two new `MergeDecision` reasons ship with it, kept apart from the existing ones because each points
at a different fix: `role_requires_review` (a teammate on a higher tier can merge this PR as it
stands) and `dry_run` (the scores were never consulted, so no threshold explains this outcome).

Wire and schema changes: `RiskPolicy` gains two required fields, `ExecutionInstance` gains optional
`initiatedByRole` and `mode`, and `merge_threshold_presets` gains a `class_rules_by_role` and a
`dry_run_roles` column on both runtimes (both with empty defaults, so existing rows need no
backfill).

Not yet built: the SPA controls for AUTHORING either preset field and for choosing a dry run on the
start-run button. Both are already writable over `/workspaces/:ws/risk-policies` and the start
endpoint respectively, so the capability is reachable today through the API.
