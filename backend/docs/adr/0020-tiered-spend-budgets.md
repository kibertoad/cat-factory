# ADR 0020: Tiered spend budgets (account / workspace / user) with operator hard caps

- **Status:** Accepted (implemented)
- **Date:** 2026-07-10
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/spend`, `@cat-factory/server`, `backend/runtimes/*`), frontend (`@cat-factory/app`)

## Context

The spend safeguard had a single budget dimension: a per-workspace monthly limit
(`workspace_settings.spend_monthly_limit`), with usage metered into `token_usage`
keyed only by `workspace_id`. There was no way to cap spend across an account's
workspaces, or across everything a single user initiates, and no way for an
operator to impose a hard ceiling on what a UI user could configure for either.

## Decision

Budget tracking is granular across three tiers, and a run is gated when **any**
applicable tier is exhausted:

- **Account** — a monthly cap across all of an account's workspaces, stored on the
  `accounts` row (`spend_monthly_limit`) and edited via the existing
  `PATCH /accounts/:id`.
- **Workspace** — the pre-existing per-workspace monthly limit, unchanged.
- **User** — a monthly cap on what a single user initiates across every
  workspace, stored in a new per-user `user_settings` table and edited via a new
  root-mounted `GET/PUT /user-settings`.

`token_usage` gained nullable `account_id` + `user_id` columns (populated at the
single existing record call site, `LlmProxyController`, which already has both
ids in scope), plus batched rollup reads (`totalsSinceForAccount` /
`totalsSinceForUser`) mirroring the existing `totalsSinceForWorkspace`.

On top of the configurable tiers, an operator can set two environment variables —
`BUDGET_MAX_MONTHLY_PER_ACCOUNT` and `BUDGET_MAX_MONTHLY_PER_USER` — that act as
hard ceilings: a UI-configured value cannot exceed the cap (enforced
server-side), the cap is shown on the budget configuration screen, and it is
also the effective tier limit when nothing is configured. `SpendService`
computes each tier's effective limit as `min(configured, cap)` (either may be
absent; absent+absent means no gate). The caps are read by both the Node and
Cloudflare config loaders, so they apply to Node, Cloudflare, and mothership
deployments, and are inert in a single-user local deployment.

The workspace snapshot carries `spend` (workspace), `accountSpend`, `userSpend`,
the editable `userSettings`, and `budgetCaps` for display.

## Rationale

- **Extend, don't replace.** The new tiers reuse the existing rollup substrate
  and record call site rather than adding a parallel metering path.
- **Ride existing entities where they fit.** The account tier rides the
  `accounts` row and its existing PATCH endpoint (mirroring
  `defaultCloudProvider`); the user tier mirrors the shape of the existing
  per-user `local_model_endpoints` stack rather than inventing a new pattern.
- **Operator ceilings need to be a hard floor, not just a UI hint.** Enforcing
  the env caps server-side (not just disabling the input) prevents a
  workspace/account admin from configuring around an operator-imposed limit.
- **Keep the runtimes symmetric.** Every D1 change (new columns, new table) has
  a Drizzle mirror plus a conformance assertion.

## Consequences

- Account- and user-tier budgets are denominated in the base pricing currency;
  only the workspace tier keeps its per-workspace `spendCurrency` override, since
  currency there is a display label — the price table itself is always in the
  base currency.
- Subscription-harness usage (Claude Code / Codex) is not metered into
  `token_usage`, so the three tiers cover proxy-metered usage only — a
  documented limitation, not a regression.
