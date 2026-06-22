# Model support — selection, fallbacks, harnesses & provisioning

How Cat Factory decides **which model runs a step, where it runs, and what it
costs**. The behaviour is spread across the catalog (kernel), the routing/resolution
logic (agents), the executor (server), and each runtime facade's provisioning. This
page is the single place that ties it together; it links back to the source so the
details stay verifiable.

> The domain only ever names a model by a provider-agnostic
> [`ModelRef`](../packages/kernel/src/ports/model-provider.ts) (`{ provider, model,
harness?, contextTokens? }`). Concrete SDKs and API keys live behind the
> `ModelProvider` port in each facade, never in the core.

---

## 1. The mental model

A model selection answers three independent questions:

1. **Which catalog model?** — what the user picked on the block, or the default for
   the step's agent kind. (§3 _Model resolution_.)
2. **Which flavour of it?** — the same model can run on Cloudflare Workers AI, on its
   vendor's direct API, or on a subscription harness. The flavour is chosen
   automatically from what's configured. (§2 _Catalog & flavours_, §4 _Flavour
   precedence_.)
3. **Where does it run?** — inline (a single `generateText` call) or inside a per-run
   container, and through which **harness** (`pi` / `claude-code` / `codex`). (§5
   _Harnesses_.)

Everything below is a fallback ladder: the system always resolves to _something that
works for this deployment_ rather than failing because the most capable option isn't
configured. A minimal deployment with **no provider keys** runs every model on
Cloudflare Workers AI.

---

## 2. The catalog & its three flavours

The curated picker catalog is
[`MODEL_CATALOG`](../packages/kernel/src/domain/models.ts) (`SelectableModel[]`). Each
entry has a stable `id` (persisted on `Block.modelId`) and up to three flavours:

| Flavour          | Field on the model              | When it's used                                                                       |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| **Cloudflare**   | `cloudflare: ModelRef`          | Always available (the `AI` Workers-AI binding / Cloudflare-over-REST). The fallback. |
| **Direct**       | `direct: { ref, keyEnv }`       | Transparently replaces Cloudflare **when `keyEnv`'s API key is set**.                |
| **Subscription** | `subscription: { ref, vendor }` | Runs in the Claude Code / Codex harness on a pooled subscription token.              |

Three shapes of catalog entry fall out of this:

- **Cloudflare-only** — e.g. `cloudflare-llama`, `kimi-k2.7`, `deepseek-v4-pro`. One
  flavour, always on the binding.
- **Dual-mode** — `qwen`, `kimi`, `deepseek`, `glm`. A Cloudflare base **plus** a
  direct and/or subscription flavour. Note the **context window** usually differs:
  the Cloudflare variant runs a cut context (e.g. GLM-5.2 24K) while the
  direct/subscription variant gets the full window (GLM-5.2 200K). `contextTokens` on
  the `ModelRef` surfaces this in the picker.
- **Subscription-only** — `claude-opus`, `claude-sonnet`, `gpt-5.5`, `gpt-5.4`. No
  Cloudflare/direct base; the subscription harness is the _only_ way to run them, so
  they require a connected vendor token (§6) and there is **no inline fallback** (§5).

The effective, display-ready projection (which flavour is actually active, plus
informational cost and context window) is computed by `effectiveCatalog()` and served
read-only at **`GET /models`** — labels and provider/model ids only, never keys.

---

## 3. Model resolution — which model runs a step

Resolved by `resolveStepModelRef` /
[`agent-routing.ts`](../packages/agents/src/agents/agent-routing.ts), in precedence
order:

1. **The block's pinned model** (`Block.modelId`) → `resolveBlockModel(modelId)` →
   `resolveModelRef` against the catalog. A model is shared by _all_ of a block's
   pipeline steps.
2. **The workspace's per-agent-kind default** (the model-defaults library, optional),
   via `resolveWorkspaceModelDefault`.
3. **The deployment's env routing default for the agent kind**
   (`routing.byKind[kind]`, else `routing.default`).

The env routing defaults (Cloudflare:
[`config/agents.ts`](../runtimes/cloudflare/src/infrastructure/config/agents.ts);
Node: [`config.ts`](../runtimes/node/src/config.ts)) are deliberately tiered:

| Agent kind                               | Default model                                        | Why                                          |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Unpinned default (tester, doc planning…) | **Qwen** (`AGENT_DEFAULT_PROVIDER/MODEL`, else Qwen) | Cheap MoE handles light kinds.               |
| `architect`, `reviewer`                  | **GLM-5.2** on Workers AI                            | Strong agentic loop for design/review.       |
| `coder`                                  | **Kimi K2.7** on Workers AI                          | Holds up on the longest, tool-heaviest loop. |

Operators override any kind via `AGENT_MODELS` (JSON). The **ultimate fallback** is
always Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`) — so an unconfigured deployment still
runs real work with no provider key.

---

## 4. Flavour precedence — "subscriptions always win"

Given a resolved catalog model, which flavour actually runs?

```
subscription  >  direct  >  cloudflare
```

- **Base flavour** (`effectiveVariant`, kernel `models.ts`): `direct` when its
  `keyEnv` key is configured, else `cloudflare`. This is what `GET /models` shows as
  the model's active flavour for the deployment.
- **Subscription override** (`subscriptionOptionFor` + the executor's
  `resolveEffectiveRef`, [`ContainerAgentExecutor.ts`](../packages/server/src/agents/ContainerAgentExecutor.ts)):
  a subscription-only model carries its harness already; a **dual-mode** model is
  switched to its subscription flavour **whenever the workspace has a pooled token for
  the vendor** (`hasSubscriptionToken`). So connecting a poolable coding-plan
  subscription (Kimi/DeepSeek) silently upgrades those models to the full-context,
  flat-rate harness path for that workspace. The `individualOnly` vendors (GLM, Codex,
  Claude) are never pooled — their dual-mode flavour upgrades per-user via the personal
  subscription a run's initiator unlocks (see §6), not via a workspace token.

`DirectKeyAvailable` (`(keyEnv) => boolean`) is built per facade from the env
(Cloudflare `config/utils.ts`, Node `config.ts`); it's what gates the direct flavour.

---

## 5. Harnesses — where a model runs

The `harness` on a `ModelRef` (`pi` | `claude-code` | `codex`, default `pi`) decides
how a container step authenticates and reaches the model:

- **`pi`** (default) — the repo-operating agent kinds (`coder`, `mocker`,
  `playwright`, `blueprints`, `ci-fixer`, `conflict-resolver`, `merger`) run inside a
  per-run container and reach models through the **LLM proxy**. The proxy can only
  serve **proxyable providers** — `workers-ai`, `qwen`, `deepseek`, `moonshot`,
  `openai` (`isProxyableProvider`). A Pi step pinned to a non-proxyable provider fails
  loudly at dispatch ("…needs a model the LLM proxy can serve…").
- **`claude-code` / `codex`** (subscription harnesses) — talk **direct to the vendor**
  with a leased token (no proxy session): a pooled workspace token for the poolable
  vendors (Kimi/DeepSeek), or the run-initiator's per-user personal credential for the
  `individualOnly` vendors (Claude/GLM/Codex). The proxyable guard does not apply.

### Inline vs container, and the degradation seam

Many agent kinds run **inline** (a single `generateText` call via `AiAgentExecutor`):
architect, reviewer, tester, the `acceptance` scenario writer, the requirements
reviewer/rework, doc planning, etc. Inline calls go through the `ModelProvider`, which
needs a real provider key.

Because a model is shared by _every_ step of a block, a block pinned to a
**subscription-only / container-only** model would break the inline steps (the vendor
has no provider key — the credential is a container-only pooled token). The single
seam that prevents this is
[`inlineModelRef(ref, fallback)`](../packages/kernel/src/ports/model-provider.ts):

> A ref demanding a non-`pi` harness is degraded to the step's env-routing default
> (`resolveInlineModelRef`); a `pi`/absent harness passes through unchanged.

So the container steps keep the subscription harness while the inline steps fall back
to a provider model — used by both the inline agent executor and the requirements
reviewer/rework so the two paths can't drift.

---

## 6. Subscriptions (the vendor token pool)

A workspace can connect one or more **subscription credentials per vendor** for the
**poolable, organization-permitted coding-plan vendors** (`kimi`, `deepseek`) so agent
steps run on the Claude Code harness instead of an API key. See
[`SUBSCRIPTION_VENDORS`](../packages/kernel/src/domain/models.ts) for the
vendor→harness map and base URLs. **Claude, GLM and ChatGPT/Codex are NOT in this
pool** — each is licensed for individual use only and stored per-user (see below).

- **Storage**: a per-workspace pool (`provider_subscription_tokens`, D1 + Postgres),
  **encrypted at rest** under an `ENCRYPTION_KEY`-derived key; tokens are write-only
  (only metadata + rolling usage is returned). Managed by `ProviderSubscriptionService`
  ([integrations](../packages/integrations/src/modules/providers/ProviderSubscriptionService.ts)),
  exposed at `GET|POST|DELETE /workspaces/:ws/vendor-credentials` and the
  **LLM Vendors** navbar UI.
- **Rotation**: leasing is usage-aware (least-loaded token wins, round-robin by
  `lastUsedAt`); the pool is capped per vendor.
- **What each vendor is**: `kimi`/`deepseek` — a coding-plan API key driven by Claude
  Code against the vendor's Anthropic-compatible endpoint (Moonshot / DeepSeek).
- `addToken`/`leaseToken` throw a `ConflictError` (HTTP 409) for any `individualOnly`
  vendor (Claude/GLM/Codex) — those never enter the pool.

### Individual-usage subscriptions: per-user, not pooled

`claude`, `glm` (Z.ai Coding Plan) and `codex` (ChatGPT) are each licensed for
**individual use only** by their own terms, so none is ever pooled or shared. Instead
each user stores their **own** credential and only that user's runs may use it. The
behaviour is gated by the `individualOnly` flag on the vendor config and implemented as a
separate, per-user **individual-usage restricted mode**:

- Stored per-user, **double-encrypted** (a personal-password layer inside the system
  layer) and unlocked with the user's password at task start/retry; a short-lived
  per-run activation lets the async container steps run without the user present.
- **Recurring schedules** can't use them (no unattended unlock).
- Organizations that need shared, programmatic access use a **direct provider API key**
  instead — that path is unaffected by `individualOnly`.

The full model, the safeguards, and the request flow are documented in
**[individual-subscription-usage.md](./individual-subscription-usage.md)**.

---

## 7. Spend budget vs flat-rate quota

Subscription runs are **flat-rate quota** (a fixed-price plan), not billed per token,
so they must not be blocked by an exhausted **monetary** spend budget:

- The picker marks subscription flavours `quotaBased: true` (kernel `models.ts`).
- `ContainerAgentExecutor.isQuotaBased` returns true iff the _effective_ ref carries a
  `claude-code`/`codex` harness — shared with dispatch so the two agree.
- The spend gate (`ExecutionService`) pauses an over-budget run **only when the step
  is not quota-based**; a subscription step keeps running. Direct/Cloudflare (Pi) runs
  are metered against the budget as usual (`SPEND_MONTHLY_LIMIT`, `SPEND_MODEL_PRICES`).

---

## 8. Provisioning per runtime

Both facades compose a model registry from `@cat-factory/agents`'
**`CompositeModelProvider`** (single-provider resolvers, each registered only when its
credentials exist). An **unconfigured provider isn't registered**, so `resolve()`
throws a clear `Unsupported model provider: <provider>` instead of failing deep in the
SDK. Base URLs are the single source of truth in
[`providers/endpoints.ts`](../packages/agents/src/providers/endpoints.ts).

|                   | **Cloudflare Worker**     | **Node / local**                                                                               |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| Cloudflare models | `AI` binding              | over REST (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_AI_GATEWAY`) |
| Direct vendors    | `*_API_KEY` secrets       | `*_API_KEY` env                                                                                |
| Subscriptions     | requires `ENCRYPTION_KEY` | requires `ENCRYPTION_KEY`                                                                      |
| Bedrock           | opt-in (`BEDROCK_*`)      | opt-in (`BEDROCK_*`)                                                                           |

### Config / env reference

| Knob                                                                                                       | Effect                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`                                                     | Upgrade the dual-mode model to its **direct** (OpenAI-compatible) flavour.                                                                   |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`                                                                      | First-party providers (used by `AGENT_MODELS` routing overrides).                                                                            |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Node)                                                    | Serve Cloudflare Workers AI models over REST (no binding off-Cloudflare).                                                                    |
| `AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL` / `AGENT_DEFAULT_TEMPERATURE` / `AGENT_MAX_OUTPUT_TOKENS` | The unpinned routing default.                                                                                                                |
| `AGENT_MODELS` (JSON)                                                                                      | Per-agent-kind routing overrides.                                                                                                            |
| `BEDROCK_REGION`                                                                                           | Registers the opt-in Bedrock resolver (see below).                                                                                           |
| `BEDROCK_MODELS` (comma-separated)                                                                         | The Bedrock **allow-list**.                                                                                                                  |
| `ENCRYPTION_KEY` (base64, ≥32 bytes)                                                                       | Master key sealing the subscription token pool (and other integration credentials). Without it the vendor-credential endpoints return `503`. |
| `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`, `SPEND_MODEL_PRICES`                                              | Monetary budget gate (does not apply to quota runs).                                                                                         |

### AWS Bedrock (opt-in)

[`@cat-factory/provider-bedrock`](../packages/provider-bedrock) adds a `bedrock`
resolver, mixed into a facade's registry **only when `BEDROCK_REGION` is set**. It
enforces a **supported-model allow-list** (`BEDROCK_MODELS`): a model id outside the
list throws `Unsupported Bedrock model: <model>` rather than forwarding an
unvetted id.

---

## 9. Quick reference — the resolution pipeline

```
Block.modelId ──► resolveStepModelRef
  1. block pin  ─┐
  2. ws default  ├─► catalog model ──► effectiveVariant (direct? else cloudflare)
  3. env default ─┘                         │
                                            ├─ dual-mode + workspace has token ─► subscription flavour ("subscriptions win")
                                            │     └─ individual-only vendor (claude) ─► initiator's PERSONAL subscription (per-run activation)
                                            │
                       ┌────────────────────┴────────────────────┐
                  container step                              inline step
                  harness pi  ─► LLM proxy (proxyable only)   inlineModelRef: non-pi harness ─► env routing default
                  harness claude-code/codex ─► lease pool token (or personal activation for claude), direct to vendor (quota-based)
```

---

## See also

- Runtime flows (execution, merge lifecycle, requirements review):
  [`CLAUDE.md`](../../CLAUDE.md).
- Backend layering & the `GET /models` endpoint: [`backend/README.md`](../README.md).
- Spend safeguard: `@cat-factory/spend`.
- Self-hosted runner pool (where container steps dispatch off-Cloudflare):
  [`runner-pool-integration.md`](./runner-pool-integration.md).
