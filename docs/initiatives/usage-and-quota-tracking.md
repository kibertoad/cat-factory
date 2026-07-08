# Initiative: token-usage & subscription-quota tracking

**Status:** in progress (Part A pilot) · **Owner:** core · **Started:** 2026-07-08

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Operators need to **see token usage across the whole platform** — for both metered API-key
traffic AND flat-rate subscription harnesses (Claude Code / Codex / GLM / pooled Kimi &
DeepSeek) — and, for quota-based subscriptions, to **see how much of the current quota
cycle is left and when it resets**.

Today two token pipelines exist and neither answers those questions:

- **`llm_call_metrics`** (telemetry) — rich per-call rows, but **per-execution only**,
  **3-day retention**, no cross-run/model/vendor rollup.
- **`token_usage` / `SpendService`** (spend ledger) — durable (~395 d) with real
  per-workspace/account/user rollups and per-model cost, **but subscription-harness usage
  is deliberately excluded** (subscriptions are `quotaBased`, not budget-metered), so it
  only ever sees API-key/proxy traffic. Subscription usage lands only in the coarse ~5h
  rolling counter on `provider_subscription_tokens` (pooled only) and in the ephemeral
  `llm_call_metrics`.

There is **no quota-cycle / reset entity anywhere** — that part is greenfield.

The end state:

- **Part A** — one durable usage ledger that counts _both_ metered and subscription tokens,
  with reporting rollups (by model, by vendor, by day) surfaced in a "Usage" tab. The
  budget gate keeps counting only metered rows, so gating behaviour is unchanged.
- **Part B** — a subscription **quota-cycle** model (used %, window, reset time) that
  reports _real_ numbers where a vendor exposes them and _modeled_ numbers where it
  doesn't, visualized with progress bars per user (personal subscriptions) and per pooled
  token (workspace).

## Quota-cycle feasibility (investigation result — drives Part B)

The subscription harnesses read the CLI's machine-readable output; that stream is **not**
always where the quota data lives. Verdicts per vendor:

| Vendor                                 | Real used%/reset retrievable? | How                                                                                                                                                                                                                                                   | Reset form                                                    | On the headless harness path?                                                                   |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Claude** (Pro/Max, `sk-ant-oat01-…`) | ✅                            | Undocumented `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token (available in-container); or statusLine stdin `rate_limits` on Claude Code ≥2.1.x; or `anthropic-ratelimit-unified-*` response headers                              | Absolute `resets_at` (epoch/ISO); **5h + 7d** rolling windows | Not in `--output-format stream-json` — needs an out-of-band endpoint call or statusLine capture |
| **Codex** (ChatGPT Plus/Pro)           | ⚠️ partial                    | `RateLimitSnapshot` (`primary`/`secondary`, `used_percent`, `window_minutes`, `resets_in_seconds`) exists but **`codex exec --json` currently emits `rate_limits: null`** (openai/codex#14728). Must **model** the 5h + weekly windows from first-use | Relative `resets_in_seconds` when present                     | **No** — headless path returns null today                                                       |
| **GLM** (Z.ai)                         | ✅ (unofficial)               | `GET /api/monitor/usage/quota/limit` (+ `model-usage`/`tool-usage`), token in `Authorization` header (no `Bearer`)                                                                                                                                    | Countdown; **5h + weekly** (+ monthly MCP)                    | Yes (side-channel HTTP call)                                                                    |
| **Kimi / DeepSeek** (pooled)           | ➖                            | No published subscription quota window; the existing `provider_subscription_tokens` rolling counter (~5h) is a rotation heuristic, not a real quota                                                                                                   | —                                                             | n/a                                                                                             |

**Consequences for Part B:**

- Getting _real_ Claude/GLM numbers requires the **executor-harness to make the side-channel
  call and return a quota snapshot on `RunnerJobResult`** → an **executor-harness image
  bump** (per the harness-image rules in CLAUDE.md). Plan this as its own image-bumping
  slice.
- Codex + pooled vendors get a **modeled** 5h / weekly window anchored at first-observed use,
  with per-plan absolute ceilings taken from config/defaults (no vendor publishes absolute
  numbers — only percentages).
- Model this as a `SubscriptionQuotaProvider` **port + adapter registry + inference
  fallback**, copying the shape of `RegistryReleaseHealthProvider`
  (`integrations/modules/observability`): a per-vendor adapter supplies the vendor read, the
  composite owns persistence + the modeled fallback + the reduction. A vendor with no
  adapter degrades to the modeled window rather than failing.

## Target pattern (Part A — the reference implementation for the ledger)

Part A **extends the existing `token_usage` ledger** rather than adding a parallel table —
reuse the rollup substrate (`totalsSince*`, per-workspace/account/user) that already exists.

1. **Discriminator column** on `token_usage`: `billing TEXT NOT NULL DEFAULT 'metered'`
   (`'metered' | 'subscription'`) + `vendor TEXT` (nullable; the subscription vendor, null
   for metered). D1 migration ⇄ Drizzle schema + generated migration (symmetric).
2. **Spend queries filter to metered.** `totalsSince*` (the budget/`status`/`isOverBudget`
   consumers) gain `AND billing = 'metered'` so subscription rows never inflate spend or
   trip a budget. This is the load-bearing invariant — subscription usage is counted for
   _reporting_ but excluded from _gating_.
3. **Reporting queries** (new, unfiltered by billing): `usageBreakdown(scope, since)`
   returning rows grouped by `(billing, vendor, provider, model)` with summed
   input/output/cost + call count; used by the Usage tab. One chunked query, no N+1.
4. **Record subscription usage.** `SpendService.record` takes `billing`/`vendor` (default
   `'metered'`). Rather than a new facade-wired dep, capture rides the engine's existing
   metering seam: `ContainerAgentExecutor.pollJob` stamps `usage` + `usageBilling:'subscription'`
   - `usageVendor` onto the `AgentRunResult` for a subscription run — identified unambiguously
     by the presence of `result.callMetrics` (only the proxy-bypassing subscription harnesses
     emit them; Pi is proxy-metered and has none). `RunDispatcher.recordStepResult` (which already
     owns `spend`) then records it with the right billing. This needs **zero new facade wiring**
     and can't double-count Pi.
5. **Controller + contract.** `GET /workspaces/:ws/usage` → the breakdown for the current
   period (+ optional range). Contract in `@cat-factory/contracts`.
6. **Frontend.** A `useUsageStore` (snapshot-fed for headline totals, endpoint-fed for the
   breakdown) + a "Usage" tab in `WorkspaceSettingsPanel.vue` next to Budget, rendered with
   `<UProgress>` bars (reused from `PipelineProgress.vue`) and the `formatTokens` helper.
7. **Conformance.** Assert the metered-vs-subscription split (a subscription call is counted
   in the breakdown but excluded from `status`/`isOverBudget`) on both runtimes.
8. **Changeset** for every touched published package.

## Per-slice checklist

| #   | Slice                           | Scope                                                                                                                                                                                                                                               | Status  | PR       |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| A1  | Ledger schema + port            | `billing`/`vendor` on `token_usage` (D1 + Drizzle + migrations), `TokenUsageRecord`, `SpendService.record` billing, `totalsSince*` metered-filter, `usageBreakdownForWorkspace` repo method (both repos)                                            | ✅ done | (part-a) |
| A2  | Subscription capture            | `AgentRunResult.usageBilling`/`usageVendor`; `ContainerAgentExecutor.pollJob` stamps subscription usage (gated on `callMetrics`); `RunDispatcher.recordStepResult` forwards billing/vendor. No new facade wiring — the engine already owns `spend`. | ✅ done | (part-a) |
| A3  | Reporting API                   | `GET /workspaces/:ws/usage` controller + `usageReportSchema` contract + rpc allow-list; `SpendService.usageBreakdown` (currency + rows)                                                                                                             | ✅ done | (part-a) |
| A4  | Usage tab (frontend)            | `useUsageStore`, `UsageSettings.vue`, `WorkspaceSettingsPanel` tab, i18n (`en` + all 9 locales, real translations), `getUsage` api client                                                                                                           | ✅ done | (part-a) |
| A5  | Conformance + changesets        | metered-vs-subscription split assertion on both runtimes (`FakeAgentExecutor` `usageBilling`/`usageVendor` option); changeset                                                                                                                       | ✅ done | (part-a) |
| B1  | Quota port + modeled provider   | `SubscriptionQuotaProvider` port + adapter registry + modeled (first-use) window fallback; `subscription_quota_cycles` table (D1 ⇄ Drizzle); persist per user/pooled-token                                                                          | ⬜ todo |          |
| B2  | Real Claude/GLM reads (harness) | executor-harness calls `/api/oauth/usage` (Claude) + `/api/monitor/usage/quota/limit` (GLM), returns a quota snapshot on `RunnerJobResult`; **image bump** + the 3 pinned tags + `RECOMMENDED_HARNESS_IMAGE`                                        | ⬜ todo |          |
| B3  | Quota API + UI                  | quota endpoint(s); per-user quota bars in "My setup" + next to budget spend when a single individual-vendor preset is active; pooled-token quota in the Usage tab                                                                                   | ⬜ todo |          |

## Conventions / gotchas carried between iterations

- **The metered-filter invariant is load-bearing.** Any query that feeds the budget gate
  (`isOverBudget`) or the spend `status`/banner MUST filter `billing = 'metered'`. A
  subscription row leaking into a spend rollup would wrongly pause runs on a quota plan that
  costs nothing. Conformance must pin this.
- **Keep the runtimes symmetric.** Ledger columns, reporting queries, and the quota table
  land for D1 **and** Drizzle in the same change, with a conformance assertion. A
  facade-parity gap is a showstopper.
- **Subscription cost is illustrative, not billed.** A subscription row's `cost_estimate` is
  priced from the same `DEFAULT_MODEL_PRICES` table for a "what this would have cost on the
  metered API" comparison — it is never summed into a budget. Label it as illustrative in
  the UI.
- **Capture at the one seam that sees all subscription runs.** `recordSubscriptionUsage`
  (pooled) is gated on `subscriptionTokenId`; `recordHarnessCallsOnce` is not. Record the
  ledger row on the un-gated seam so personal (individual-vendor) runs are counted too.
- **Vendor derives from the model ref**, via `subscriptionVendorForRef` /
  `individualVendorForModelId` (kernel `domain/models.ts`) — do not re-hardcode a vendor
  list at the call site.
- **Part B real reads = an image bump.** The harness side-channel calls change the runner
  image; bump `@cat-factory/executor-harness` + the three pinned tags
  (`deploy/backend/package.json`, `deploy/backend/wrangler.toml`, `RECOMMENDED_HARNESS_IMAGE`)
  and add a changeset, per CLAUDE.md.
- **No N+1 in the breakdown.** The Usage tab is one GROUP BY query, not a per-model loop.
- **Undocumented endpoints are best-effort.** Claude `/api/oauth/usage` and GLM
  `/api/monitor/*` are unofficial; a failed/absent read degrades to the modeled window, never
  fails a run.
