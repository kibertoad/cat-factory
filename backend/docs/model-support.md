# Model support: selection, fallbacks, harnesses & provisioning

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

1. **Which catalog model?**: what the user picked on the block, or the default for
   the step's agent kind. (§3 _Model resolution_.)
2. **Which flavour of it?**: the same model can run on Cloudflare Workers AI, on its
   vendor's direct API, or on a subscription harness. The flavour is chosen
   automatically from what's configured. (§2 _Catalog & flavours_, §4 _Flavour
   precedence_.)
3. **Where does it run?**: inline (a single `generateText` call) or inside a per-run
   container, and through which **harness** (`pi` / `claude-code` / `codex`). (§5
   _Harnesses_.)

Everything below is a fallback ladder: the system always resolves to _something that
works for this deployment_ rather than failing because the most capable option isn't
configured. A minimal deployment with **no provider keys** runs every model on
Cloudflare Workers AI.

---

## 2. The catalog & its flavours

The curated picker catalog is
[`MODEL_CATALOG`](../packages/kernel/src/domain/models.ts) (`SelectableModel[]`). Each
entry has a stable `id` (persisted on `Block.modelId`) and one flavour per route it can be
reached on. The vocabulary is `MODEL_FLAVORS`, listed here in the order
`DEFAULT_PROVIDER_PREFERENCE` prefers them:

| Flavour          | Field on the model              | When it's used                                                                         |
| ---------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| **Direct**       | `direct: { ref, keyEnv }`       | The model's own provider API, **when a key for it is configured**.                     |
| **Bedrock**      | `bedrock: { baseModelId }`      | AWS Bedrock, when the deployment's `BEDROCK_MODELS` allow-list carries the model (§8). |
| **OpenRouter**   | `openrouter: { ref, keyEnv }`   | The same model through the gateway, when an OpenRouter key is set.                     |
| **Cloudflare**   | `cloudflare: ModelRef`          | Always available (the `AI` Workers-AI binding / Cloudflare-over-REST). The floor.      |
| **Subscription** | `subscription: { ref, vendor }` | Runs in the Claude Code / Codex harness on a pooled subscription token.                |

Two rules set that order: a **first-party route wins over an aggregator that resells it**
(`direct`/`bedrock` before `openrouter`), and Cloudflare is the always-available floor
below every route a key or account grant unlocks. `subscription` sits last **only because
the "subscriptions always win" rule is applied separately, one layer up**; see §4, which
also explains why moving it is its own piece of work.

`effectiveVariant` walks that order twice: first over what the capabilities make USABLE,
then over what the entry merely DECLARES, so a caller always gets a ref to display even
when nothing is configured (`available: false` is what says it can't run). Both walks
follow the same order, or the picker would name one route and the run would take another.
Each flavour supplies its `declared`/`usable`/`build` arms through an exhaustive
`Record<ModelFlavor, …>`, so **adding a route fails to compile until every arm is
handled**.

### The order is a per-preset choice

That table is the DEFAULT order. A **model preset** can state its own
(`ModelPreset.providerPreference`), which is what lets one workspace run a compliance preset
pinned to a residency-guaranteed route (AWS Bedrock) and an everyday preset riding a flat-rate
subscription. It is per preset rather than per deployment because it is a per-workload choice,
and it needs no new env var: the knob is the preset row.

Three rules make it safe:

- **A preference REORDERS, it never filters.** Routes a preset omits are appended in default
  order and tried last, so a preset naming three routes cannot make a model whose only route is
  the fourth unresolvable. `orderedModelFlavorPreference` (contracts) returns a total order over
  every route, which is what makes that structural rather than a rule to remember, and it is why
  the editor offers no way to remove a route. The write boundary refuses a REPEATED route (an
  order can't say two things about one route) but accepts a partial list.
- **It rides `ProviderCapabilities`, not a resolution parameter.** Every site that resolves a
  model already threads a capability set, so a new call site cannot silently resolve under a
  different order than the picker displayed. The facades fold it ONTO the deployment
  capabilities rather than replacing them: which routes exist is a deployment fact, and the
  preset only reorders how they are preferred.
- **It is resolved ONCE per dispatch by the engine**, onto `AgentRunContext.providerPreference`
  (`resolveDispatchProviderPreference`, beside the prompt override and the output budget), so
  the container, inline and consensus paths cannot disagree about which provider a step ran on.
  Inline callers that run OUTSIDE a dispatch (the judge, the fork chat, the iterative reviewers,
  the interviewers, the tester QC companion, the bug-hunt assessor) resolve it themselves
  through the one shared `resolveInlineBlockModelRef`; the start guard resolves capabilities
  under the block's own preset for the same reason.

The default order itself lives in ONE place, `DEFAULT_MODEL_FLAVOR_ORDER` in
`@cat-factory/contracts` (the picklist order IS that order), because the preset editor renders
the same fold the resolver walks — a copy in the SPA would let the picker display an order the
run does not take.

Several shapes of entry fall out of this:

- **Cloudflare-only**, e.g. `cloudflare-llama`, `kimi-k2.7`, `gpt-oss-120b`. One
  flavour, always on the binding.
- **Dual-mode**: `qwen`, `kimi`, `deepseek`, `deepseek-v4-pro`, `glm`. A Cloudflare
  base **plus** a direct, OpenRouter and/or subscription flavour. Note the **context
  window** usually differs: the Cloudflare variant runs a cut context (e.g. DeepSeek V4
  Pro 131K) while the direct/subscription variant gets the full window (1M).
  `contextTokens` on the `ModelRef` surfaces this in the picker.
- **Gateway-only**: `gemini`, `gemini-flash`, `kimi-k3`. No Cloudflare/direct base;
  reached through OpenRouter once a key is connected.
- **Bedrock-only**: `claude-opus-4-8`. Reachable only in an AWS account whose allow-list
  carries it. It is a **separate entry rather than a `bedrock` flavour on `claude-opus`**,
  because Bedrock lags Anthropic: folding it in would silently run 4.8 for a block pinned
  to Opus 5. Any entry whose model Bedrock serves at the SAME generation (`gpt-5.5`,
  `gpt-oss-120b`) does carry the flavour directly.
- **Subscription-only**: `claude-sonnet`. No Cloudflare/direct/OpenRouter base; the
  subscription harness is the _only_ way to run it, so it requires a connected vendor
  token (§6) and there is **no inline fallback** (§5). `claude-fable`, `claude-opus` and
  the GPT-5.6 / GPT-5.5 tiers pair their subscription flavour with an OpenRouter
  pay-as-you-go base, so they are dual-mode rather than subscription-only.
- **Local (per-user)**: locally-run models on a user's own runner (Ollama / LM Studio /
  llama.cpp / vLLM / custom OpenAI-compatible). NOT static catalog entries: each user
  configures runners in the UI ("My local runners", stored per-user in
  `local_model_endpoints`), and their enabled models are appended to `GET /models`
  dynamically (id `"<provider>:<model>"`, e.g. `ollama:gemma3`). They present as the
  `direct` flavour but need **no API key**: gated by the new `localModels` capability (the
  set of model ids the user has _enabled_, so usability is model-granular), not a `keyEnv`.
  At run time the LLM proxy + inline provider resolve the **run initiator's** endpoint (base
  URL + optional bearer key) and skip the DB key lease, mirroring the personal-subscription
  initiator model. The base URL is constrained to a loopback/LAN allow-list
  (`localRunnerUrlError`) since it's forwarded server-side. `parseLocalModelId` turns the
  dynamic id into a `ModelRef` so `resolveModelRef`/`resolveBlockModel` resolve it even at
  config time (when per-user capabilities aren't known).

The effective, display-ready projection (which flavour is actually active, plus
informational cost and context window) is computed by `effectiveCatalog()` and served
read-only at **`GET /models`**: labels and provider/model ids only, never keys.

---

## 3. Model resolution, which model runs a step

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
always Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`), so an unconfigured deployment still
runs real work with no provider key.

---

## 4. Flavour precedence: "subscriptions always win"

Given a resolved catalog model, which flavour actually runs?

```
subscription  >  direct  >  cloudflare
```

- **Base flavour** (`effectiveVariant`, kernel `models.ts`): the first route the capabilities
  make usable, walking the preset's own order when it states one and
  `DEFAULT_PROVIDER_PREFERENCE` otherwise: `direct` when a key for its provider is in the pool,
  else `bedrock` when the allow-list carries the model, else `openrouter`, else `cloudflare`
  (§2). This is what `GET /models` shows as the model's active flavour, under the workspace
  DEFAULT preset's order (a task that selected another preset resolves under it at dispatch,
  where the block is in hand).
- **Subscription override** (`subscriptionOptionFor` + the executor's
  `resolveEffectiveRef`, [`ContainerAgentExecutor.ts`](../packages/server/src/agents/ContainerAgentExecutor.ts)):
  a subscription-only model carries its harness already; a **dual-mode** model is
  switched to its subscription flavour **whenever the workspace has a pooled token for
  the vendor** (`hasSubscriptionToken`). So connecting a poolable coding-plan
  subscription (Kimi/DeepSeek) silently upgrades those models to the full-context,
  flat-rate harness path for that workspace. The `individualOnly` vendors (GLM, Codex,
  Claude) are never pooled: their dual-mode flavour upgrades per-user via the personal
  subscription a run's initiator unlocks (see §6), not via a workspace token.

**Why the two layers live apart.** `subscription` is LAST in the kernel preference tuple
and FIRST in effect, which reads like a contradiction until you see what each layer knows.
The override needs per-workspace / per-run-initiator token state
(`hasSubscriptionToken` / `hasPersonalSubscription`), and the kernel resolver is ALSO called
with deployment-level capabilities that assert every vendor (`resolveBlockModel` is built
once at boot, before any workspace is in hand) and from inline paths that cannot drive a CLI
harness at all (which is why each degrades through `inlineModelRef`). Promoting
`subscription` in the tuple alone would therefore dispatch subscription runs for workspaces
holding no token, and degrade a dual-mode pin to the _routing default_ at every inline call
site rather than to the model's own base. Unifying them is the right end state and is
tracked as its own slice in
[`model-provider-preference.md`](../../docs/initiatives/model-provider-preference.md).

Note what the per-preset order (§2) does and does not change here: it decides which route the
BASE flavour walk picks, and the subscription override still sits on top of it. So a preset that
puts `subscription` first does not yet bypass that override, and a workspace holding no token is
unaffected by such an order — which is exactly the separation the outstanding slice removes.

---

## 5. Harnesses, where a model runs

The `harness` on a `ModelRef` (`pi` | `claude-code` | `codex`, default `pi`) decides
how a container step authenticates and reaches the model:

- **`pi`** (default): the repo-operating agent kinds (`coder`, `mocker`,
  `playwright`, `blueprints`, `ci-fixer`, `conflict-resolver`, `merger`) run inside a
  per-run container and reach models through the **LLM proxy**. The proxy can only
  serve **proxyable providers**: `workers-ai`, `qwen`, `deepseek`, `moonshot`,
  `openai` (`isProxyableProvider`). A Pi step pinned to a non-proxyable provider fails
  loudly at dispatch ("…needs a model the LLM proxy can serve…").
- **`claude-code` / `codex`** (subscription harnesses): talk **direct to the vendor**
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
has no provider key: the credential is a container-only pooled token). The single
seam that prevents this is
[`inlineModelRef(ref, fallback)`](../packages/kernel/src/ports/model-provider.ts):

> A ref demanding a non-`pi` harness is degraded to the step's env-routing default
> (`resolveInlineModelRef`); a `pi`/absent harness passes through unchanged.

So the container steps keep the subscription harness while the inline steps fall back
to a provider model: used by both the inline agent executor and the requirements
reviewer/rework so the two paths can't drift.

---

## 6. Subscriptions (the vendor token pool)

A workspace can connect one or more **subscription credentials per vendor** for the
**poolable, organization-permitted coding-plan vendors** (`kimi`, `deepseek`) so agent
steps run on the Claude Code harness instead of an API key. See
[`SUBSCRIPTION_VENDORS`](../packages/kernel/src/domain/models.ts) for the
vendor→harness map and base URLs. **Claude, GLM and ChatGPT/Codex are NOT in this
pool**: each is licensed for individual use only and stored per-user (see below).

- **Storage**: a per-workspace pool (`provider_subscription_tokens`, D1 + Postgres),
  **encrypted at rest** under an `ENCRYPTION_KEY`-derived key; tokens are write-only
  (only metadata + rolling usage is returned). Managed by `ProviderSubscriptionService`
  ([integrations](../packages/integrations/src/modules/providers/ProviderSubscriptionService.ts)),
  exposed at `GET|POST|PATCH|DELETE /workspaces/:ws/vendor-credentials` and the
  **LLM Vendors** navbar UI.
- **Rotation**: leasing is usage-aware (least-loaded token wins, round-robin by
  `lastUsedAt`); the pool is capped per vendor.
- **Enable/disable + default** (`PATCH …/vendor-credentials/:id`, `{ enabled?, isDefault? }`):
  a token can be taken **out of rotation** without deleting it (`enabled: false`; still
  listed and re-enablable, but never leased and not counted as "configured"), and one token
  can be **pinned as the vendor's default** (`isDefault: true`) so it is leased in preference
  to usage-aware rotation. At most one default per (workspace, vendor); a disabled default is
  ignored (leasing falls back to rotation among the remaining enabled tokens).
- **What each vendor is**: `kimi`/`deepseek`; a coding-plan API key driven by Claude
  Code against the vendor's Anthropic-compatible endpoint (Moonshot / DeepSeek).
- `addToken`/`leaseToken` throw a `ConflictError` (HTTP 409) for any `individualOnly`
  vendor (Claude/GLM/Codex): those never enter the pool.

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
  instead: that path is unaffected by `individualOnly`.

The full model, the safeguards, and the request flow are documented in
**[individual-subscription-usage.md](./individual-subscription-usage.md)**.

---

## 7. Spend budget vs non-metered runs (subscription + local)

The per-workspace **monetary** spend budget (Workspace settings → Budget) meters and gates
runs that cost the deployment money. Two kinds of run incur **no** metered cost and so are
**never** blocked by it:

- **Subscription** runs are **flat-rate quota** (a fixed-price plan), not billed per token.
  The picker marks them `quotaBased: true` (kernel `models.ts`); `ContainerAgentExecutor.
isQuotaBased` returns true iff the _effective_ ref carries a `claude-code`/`codex` harness
  (shared with dispatch so the two agree).
- **Local-runner** models (Ollama / LM Studio / llama.cpp / vLLM / custom) are **keyless**
  and run on the _user's own_ endpoint, so they cost the deployment nothing. Detected off
  the resolved model id (`parseLocalModelId`).

Direct API keys and Cloudflare Workers AI ARE metered against the budget as usual.

How the gate behaves (`ExecutionService`):

- **Mid-run:** `currentStepIsNonMetered` exempts subscription **and** local steps, so an
  over-budget run pauses **only** on a metered step; a non-metered step keeps running.
- **Up-front:** `assertBudgetAllowsPipeline` refuses `start()`/`retry()` with a clear
  `409` when the budget is reached **and** the pipeline has a metered step, rather than a
  silent mid-run pause. A pipeline whose every step is local/subscription starts normally.

### A `0` budget is intentional ("local-/subscription-only")

`spendMonthlyLimit: 0` is a **valid, deliberate** setting, not a footgun: it means "no PAID
spend". A workspace at `0` refuses metered runs (clear up-front error) but **keeps running
local-runner models and connected subscriptions**, since those incur no metered cost. It is
reversible from the UI and safer than an unbounded "unlimited" that can run up a real bill.
(Web search costs money on metered providers, so a `0` budget also blocks paid searches:
the local model itself still runs.) The budget lives on the `workspace_settings` row; there
are no longer `SPEND_MONTHLY_LIMIT` / `SPEND_CURRENCY` env vars.

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
| Workspace budget (UI → Workspace settings → Budget)                                                        | Monetary budget gate (per workspace; does not apply to quota runs).                                                                          |

### AWS Bedrock (opt-in)

[`@cat-factory/provider-bedrock`](../packages/provider-bedrock) adds a `bedrock`
resolver, mixed into a facade's registry **only when `BEDROCK_REGION` is set**. It
enforces a **supported-model allow-list** (`BEDROCK_MODELS`): a model id outside the
list throws `Unsupported Bedrock model: <model>` rather than forwarding an
unvetted id.

**`BEDROCK_MODELS` is also the per-model picker enablement.** A catalog entry carrying a
`bedrock` flavour (§2) becomes selectable exactly when this list holds its model, which is
what makes the account policy's `trustedProviders: ['bedrock']` reachable per task: a user
can pin one block to a residency-guaranteed route instead of repointing the whole
deployment's routing default. The list is parsed ONCE, by
`bedrockAllowListFromEnv` (`@cat-factory/server`), and that one value feeds both the
resolver's allow-list and the capability set. Parsed twice, the picker could offer an id
the resolver throws on.

Two consequences worth knowing:

- **`BEDROCK_REGION` with no `BEDROCK_MODELS`** leaves the resolver UNCONSTRAINED (any id
  is forwarded to AWS) and contributes **no picker flavour**. Bedrock access is granted per
  account and per Region, so with nothing enumerated the platform cannot know which entries
  are callable, and offering them would surface models AWS rejects at call time. Bedrock
  stays reachable as a routing default (`AGENT_DEFAULT_PROVIDER` + `AGENT_DEFAULT_MODEL`, or
  a per-kind `AGENT_MODELS` entry); naming a model here is how you opt it into the picker.
- **The Worker does not bundle the Bedrock package** (a deployment mixes it in via the
  `registerModelRegistry` extension point in `infrastructure/ai/registries.ts`). It reads the
  same two env vars, but grants the capability only when a registered registry can actually
  serve `bedrock` (`bedrockModelsCapability`): on Node the env that enables the flavour also
  registers the resolver, whereas here the vars alone don't prove the mix-in happened, and
  offering the flavour on them would put rows in the picker whose dispatch fails on an
  unregistered provider. Set-but-unregistered logs a warning naming the missing call.

Bedrock ids are `provider.model`, optionally carrying a **geo/global inference prefix**
(`us.` / `eu.` / `jp.` / `au.` / `global.`): several models are reachable ONLY through a
cross-Region profile in a given Region, so the prefixed form is usually what you want.
**The catalog therefore declares only the UNPREFIXED base id** (`baseModelId`) and
`resolveBedrockModelId` matches an allow-list entry that IS the base or ends in `.<base>`,
running that entry verbatim. That is what lets one catalog be correct in every Region, and
it means the prefix set is never enumerated in code (a prefix AWS adds later just works).
Where you list two profiles for one model, **the first one wins**, so ordering the var is
how you choose between a regional and a global profile.

Example `BEDROCK_MODELS` for a US account (verified Aug 2026):

```
BEDROCK_MODELS=us.anthropic.claude-opus-4-8,global.anthropic.claude-opus-4-8,openai.gpt-5.5
```

**Bedrock lags the vendors' own APIs**: its newest Anthropic model is Opus 4.8, not the
Opus 5 / Sonnet 5 the subscription and OpenRouter flavours run, and its OpenAI ids are
`openai.gpt-5.5` / `openai.gpt-5.4` rather than the GPT-5.6 tiers. Don't copy a catalog
model id into `BEDROCK_MODELS`. The catalog spans 18 providers and 110+ variants and
access is granted per account, so confirm each id against
`aws bedrock list-foundation-models` / `list-inference-profiles` for YOUR region: an id
that is real but not granted fails at call time, not at boot.

---

## 9. Quick reference: the resolution pipeline

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
