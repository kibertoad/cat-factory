---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Account-scoped risk policies, inherited by every board (ADR 0055).

A risk policy could only be authored per board, so an organisation with one merge posture had to
copy it onto every board and keep the copies in step by hand. There is now an ACCOUNT tier: policies
authored once for a whole account, which every board under it inherits read-only, may CLONE into its
own library to edit, and may HIDE so no task on that board can pick it. Managed from a new "Risk
policies" tab in Account settings; a board's own settings panel lists what it inherits above what it
owns, plus what it is hiding.

The board's visible library is `account ⊕ workspace` with the board's own row winning a collision,
and one merged reader answers for the settings editor, every picker and the ENGINE, so a task can pin
an inherited policy and the run is governed by the posture the picker offered.

Two internal breaks, both pre-1.0 surfaces:

- `RiskPolicyRepository` gained a read-only supertype `WorkspaceRiskPolicyReader`, and the engine,
  the two board guards and `resolveRiskPolicy` now hold that instead of the repository
  (`RunMergePolicyDeps` / `ExecutionServiceDependencies` renamed the field to `riskPolicyReader`).
- `GET /workspaces/:ws/risk-policies` and the board snapshot answer library entries carrying `tier`.

`GET /api/v1/risk-policies` now lists inherited policies too (an additive behaviour change: the
response shape is unchanged, and a deployment with no account policies sees exactly what it saw
before). Editing or deleting an inherited policy answers `409` with
`details.reason: 'risk_policy_inherited'`; cloning or hiding a board's own policy answers
`risk_policy_not_inherited`.
