# Tiered budgets (account / workspace / user) + operator hard caps

## Goal & rationale

Today the spend safeguard has a single budget dimension: a per-workspace monthly
limit (`workspace_settings.spend_monthly_limit`). Usage is metered into
`token_usage` keyed only by `workspace_id`, and the engine pauses a run when the
workspace is over budget.

This initiative makes budget tracking granular across three tiers:

- **Account** — a monthly cap across all of an account's workspaces.
- **Workspace** — the existing per-workspace monthly limit (unchanged).
- **User** — a monthly cap on what a single user initiates (across every workspace).

A run is gated when ANY applicable tier is exhausted. All three tiers are
configurable and visible in the UI.

On top of the configurable tiers, an operator can set two environment variables
that constrain the maximum monthly budget a UI user may configure:

- `BUDGET_MAX_MONTHLY_PER_ACCOUNT` — hard ceiling on the account-tier limit.
- `BUDGET_MAX_MONTHLY_PER_USER` — hard ceiling on the user-tier limit.

When a cap is set, the UI value cannot exceed it (validated server-side too), the
cap is shown on the budget configuration screen, and it also acts as the effective
tier limit when nothing is configured. The caps are read by the Node and Cloudflare
config loaders, so they apply in Node ("remote node"), Cloudflare remote, and
mothership deployments (a mothership is a Node/Cloudflare deployment). They are
inert in a single-user local deployment.

## Target pattern

- `token_usage` gains `account_id` + `user_id` columns (nullable). The single spend
  `record` call site (`LlmProxyController`) already has `session.accountId` +
  `session.userId` in scope, so no new plumbing at record time.
- New batched rollup reads `totalsSinceForAccount` / `totalsSinceForUser` mirror
  `totalsSinceForWorkspace`, indexed `(account_id, created_at)` / `(user_id, created_at)`.
- Account-tier limit rides the `accounts` row (`spend_monthly_limit`), edited via the
  existing `PATCH /accounts/:id` (`updateAccountSchema`) — mirrors `defaultCloudProvider`.
- User-tier limit lives in a new `user_settings` table (PK `user_id`), edited via a new
  root-mounted `GET/PUT /user-settings` — mirrors the `local_model_endpoints` per-user stack.
- The env caps ride `SpendPricing` (`accountMonthlyLimitCap` / `userMonthlyLimitCap`).
  `SpendService` computes each tier's effective limit as
  `min(configured, cap)` (either may be absent; absent+absent ⇒ no gate).
- The workspace snapshot carries `spend` (workspace), `accountSpend`, `userSpend`, the
  editable `userSettings`, and `budgetCaps` (the two env ceilings) for display.

## Conventions & gotchas

- Keep the runtimes symmetric: every D1 change has a Drizzle mirror + a conformance
  assertion (`backend/internal/conformance`).
- Account/user budgets are denominated in the base pricing currency; only the workspace
  tier keeps its per-workspace `spendCurrency` override (currency is a display label — the
  price table is always in the base currency).
- Subscription-harness usage (Claude Code / Codex) is not metered into `token_usage`
  today; the tiers cover proxy-metered usage only (documented, not a regression).

## Per-item status

| Area        | Item                                                                   | Status |
| ----------- | ---------------------------------------------------------------------- | ------ |
| contracts   | `accountSchema` / `updateAccountSchema` + `spendMonthlyLimit`          | done   |
| contracts   | `user-settings.ts` + route contracts                                   | done   |
| contracts   | `snapshot.ts`: `accountSpend`/`userSpend`/`userSettings`/`budgetCaps`  | done   |
| kernel      | `token-usage.ts`: columns + account/user rollups                       | done   |
| kernel      | `account-repositories.ts`: `spendMonthlyLimit`                         | done   |
| kernel      | `user-settings-repositories.ts` (new)                                  | done   |
| spend       | `SpendPricing` caps + `SpendService` tiers                             | done   |
| runtimes    | D1 migration `0042_tiered_budgets.sql` + repos                         | done   |
| runtimes    | Drizzle schema + migration + repos                                     | done   |
| server      | `AccountService` / `UserSettingsService` / controllers                 | done   |
| server      | snapshot assembly (`WorkspaceController`)                              | done   |
| config      | env vars in Node + Cloudflare loaders; wiring                          | done   |
| frontend    | three-tier budget UI + stores + i18n                                   | done   |
| conformance | account/user attribution + tiered enforcement                          | done   |
| docs        | `docs/environment-variables.md`                                        | done   |
| release     | changesets                                                             | done   |
