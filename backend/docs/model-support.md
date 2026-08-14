# Model support: selection, fallbacks, harnesses & provisioning

How Cat Factory decides **which model runs a step, where it runs, and what it
costs**. The behaviour is spread across the catalog (kernel), the routing/resolution
logic (agents), the executor (server), and each runtime facade's provisioning. This
page is the single place that ties it together; it links back to the source so the
details stay verifiable.

> **Configuring and using models is documented on the website**:
> [Model Providers & Subscriptions](https://www.catfactory.ai/guide/model-providers.html) owns
> connecting a key, a subscription or a local runner, presets and route order, and the model access
> policy; [Budgets](https://www.catfactory.ai/guide/budgets.html) owns what spend does to a run.
> This page is the INTERNAL account: the resolution order, the seams, and the invariants a change
> here has to keep. Do not restate usage here, and do not answer a usage question by editing this
> file.

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

### Two per-flavour facts, both declared and never inferred

A `ModelRef` carries `contextTokens` and `acceptsImages` beside the provider/model pair, and both
are per FLAVOUR rather than per entry: what a serving provider does with a model is a fact about
where it runs, not only about the model. The same catalog model can be served with a smaller window
on one route than another, and can be served with image input on one and without on another.

**Absent is a third answer for both, and `acceptsImages` is the one where it does work.** A flavour
whose modality this catalog has not declared does NOT get a run's design pictures, and the refusal
is reported under its own reason (`unknown_model_image_input`) rather than as "this model is
text-only": the two send a reader to opposite places, and collapsing them would let an undeclared
multimodal model read as a text-only one forever with nothing saying the platform never asked. So
`acceptsImages: true` is set only where the serving provider documents image input for that model
id; everything else is left absent, which is honest and self-correcting. The pairing with the
harness (a CLI that cannot read an image refuses first, whatever the model does) lives in kernel's
`resolveDesignImageDelivery`.

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

### A registration may pin its own model (judges)

A registered **judge** names the catalog model its rubric was authored for
(`JudgeDefinition.modelId`), and every judge resolves under its OWN agent kind, so each rubric
is its own row in the model defaults. That adds one layer inside step 2 of §3, resolved by
`resolveInlineBlockModel`: the task's pin, then a preset override NAMING the kind, then the
registration's pin, then the preset's base model. It sits between the two halves of the preset
because a base model is a blanket statement (a pin under it is unreachable) and a named override
is a specific one (a pin over it is a deployment constant no workspace can relax), which is why
`PresetRouting` reports `pinnedForKind` alongside the id it resolved. A pin this deployment
cannot serve is recorded on `step.judge.modelPin` as `unavailable` rather than silently swapped.

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
  **Their per-flavour facts have nowhere else to come from, so they are resolved in TWO
  tiers** (§2.1 below), because no catalog entry exists to declare them and the runner's
  `/models` probe returns ids and nothing else.
  At run time the LLM proxy + inline provider resolve the **run initiator's** endpoint (base
  URL + optional bearer key) and skip the DB key lease, mirroring the personal-subscription
  initiator model. The base URL is forwarded server-side, so it is constrained to a
  loopback-only allow-list (`localRunnerUrlError`); private-LAN hosts (RFC1918 / ULA /
  mDNS `.local`) need the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true`, which
  single-tenant local mode defaults on. On a shared deployment the LAN grant is an
  internal-network SSRF surface, which is why it is not the baseline. The policy is
  enforced at the write boundary, on the test probe, and on every redirect hop of every
  run-time forward (`LocalModelEndpointService.fetchRunner`), so a row persisted under a
  wider policy is refused loudly after the operator narrows it. `parseLocalModelId` turns the
  dynamic id into a `ModelRef` so `resolveModelRef`/`resolveBlockModel` resolve it even at
  config time (when per-user capabilities aren't known).

The effective, display-ready projection (which flavour is actually active, plus
informational cost and context window) is computed by `effectiveCatalog()` and served
read-only at **`GET /models`**: labels and provider/model ids only, never keys.

### 2.1 A local model's modality: recognised family, else the user's own declaration

`acceptsImages` is the one per-flavour fact whose absence COSTS a capability (a run withholds its
design renders), and a local model has no catalog row to carry it. Two tiers answer, and
`resolveLocalModelModality` (kernel) is the ONE place their precedence lives:

1. **The user's declaration**, per enabled model on their endpoint row
   (`LocalModelDeclaration.acceptsImages`, three-state exactly like the `ModelRef` field). It wins,
   because the person who pulled the weights is the one who knows which build they run: a text-only
   quant of a multimodal family, a fine-tune, a re-tagged local copy.
2. **`KNOWN_LOCAL_MODELS`** (`@cat-factory/contracts`), a small table of popular open-weights
   families matched by squashed id substring, so ticking Gemma 4 or Muse Glimmer needs no second
   step. It lives in contracts because the settings panel labels its "not set" option with what the
   table will do and the engine folds the same answer: a copy would let the panel promise a picture
   the run withholds. **An entry earns its place only where SILENCE costs something**, so every
   member is image-capable (a text-only entry behaves identically to an absent one), and a family
   whose modality depends on the SIZE is left OUT rather than approximated (Gemma 3: its 1B is
   text-only, its 4B and up are not).

Neither tier answering leaves the ref undeclared, which is reported as `unknown_model_image_input`
rather than as a text-only model. The run path gets the declarations from
`AgentRunContext.localModelDeclarations`, resolved once per dispatch by the engine from the RUN
INITIATOR's endpoints and folded in `resolveStepModelRef`, the one function the container, inline
and consensus paths all resolve through. It cannot ride `ProviderCapabilities` or the boot-time
`resolveBlockModel` closure: those answer whether a model may run and know no user. **No
declarations at all is the undeclared answer too, and the family table is NOT consulted for it**:
"the initiator said nothing" and "nobody resolved any declarations for this dispatch" are different
facts, and letting the table answer over the second would attach pictures to a build whose owner
declared it text-only.

**Which path can act on the answer is the HARNESS's question, and it is asked first.** A local ref
names no harness, so a container dispatch runs it on Pi, and `HARNESS_IMAGE_INPUT.pi` is `false`:
that dispatch reports `harness_no_image_input` without consulting the ref. So the delivery this
buys today happens on the INLINE path, and the container path becomes a reader the day an
image-carrying harness serves a local model, which is a `HARNESS_IMAGE_INPUT` edit rather than new
plumbing. The declaration is resolved for every path regardless, because the winning model is not
known until `resolveStepModelRef` has walked its sources.

**`contextTokens` is deliberately NOT declared for a local model.** The window a runner actually
serves is a fact about its CONFIG, not about the weights: Ollama's `num_ctx` default is far below
what a 128K-window model can do, so a declared window would be a number the platform states and the
runner silently ignores, and nothing enforces it either way (the proxy's output cap is
Workers-AI-only). A long agent loop on an under-configured runner therefore truncates silently, and
raising `num_ctx` is the operator-side fix.

---

## 3. Model resolution, which model runs a step

Resolved by `resolveStepModelRef` /
[`runtime/routing.ts`](../packages/agents/src/agents/runtime/routing.ts), in precedence
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

The consequence runs the other way too, and it is the one a user can hit: on a workspace WITH a
token, a preset promoting a residency-guaranteed route is overruled for every dual-mode model,
because the override is applied after the walk rather than inside it. The preset editor therefore
warns whenever a stated order does not itself put `subscription` first
(`ProviderPreferenceEditor.logic.ts`), rather than letting the copy promise a route a connected
plan quietly takes back. That warning is deleted by the same slice that moves the override into
the order.

---

## 5. Harnesses, where a model runs

The `harness` on a `ModelRef` (`pi` | `claude-code` | `codex`, default `pi`) decides
how a container step authenticates and reaches the model:

- **`pi`** (default): the repo-operating agent kinds (`coder`, `mocker`,
  `playwright`, `blueprints`, `ci-fixer`, `conflict-resolver`, `merger`) run inside a
  per-run container and reach models through the **LLM proxy**. The proxy can only
  serve **proxyable providers**: `workers-ai`, `qwen`, `deepseek`, `moonshot`, `xai`,
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

What a user connects, which vendors are poolable and why, and how the personal-password unlock
behaves are all on the website
([Connecting a subscription](https://www.catfactory.ai/guide/model-providers.html#connecting-a-subscription)).
What the engine needs from this layer:

- **The vendor→harness map and base URLs are one table**,
  [`SUBSCRIPTION_VENDORS`](../packages/kernel/src/domain/models.ts). A vendor's `individualOnly`
  flag is the single switch deciding pooled vs per-user; nothing else branches on the vendor name.
- **The pool is per workspace** (`provider_subscription_tokens`, D1 + Postgres), sealed under an
  `ENCRYPTION_KEY`-derived key and write-only (reads return metadata + rolling usage, never the
  token). Owned by `ProviderSubscriptionService`
  ([integrations](../packages/integrations/src/modules/providers/ProviderSubscriptionService.ts)),
  served at `GET|POST|PATCH|DELETE /workspaces/:ws/vendor-credentials`.
- **Leasing is usage-aware** (least-loaded wins, round-robin by `lastUsedAt`) unless one token is
  pinned `isDefault`. A `enabled: false` token stays listed and re-enablable but is never leased
  and does not make its vendor count as configured, and a disabled default falls back to rotation
  rather than to nothing.
- `addToken`/`leaseToken` throw a `ConflictError` (HTTP 409) for any `individualOnly` vendor, so
  the pool cannot acquire one by a caller taking a different route in.

### Individual-usage subscriptions: per-user, not pooled

`claude`, `glm` and `codex` are stored per user, double-encrypted (a personal-password layer
inside the system layer), and unlocked at task start or retry; a short-lived per-run activation
lets the asynchronous container steps run with nobody present. A recurring schedule therefore
cannot resolve to one, which the start guard refuses rather than discovering mid-run.

The full model, the safeguards, and the request flow are in
**[individual-subscription-usage.md](./individual-subscription-usage.md)**.

---

## 7. Spend budget vs non-metered runs (subscription + local)

What a budget does to a user's run is on the website
([Budgets](https://www.catfactory.ai/guide/budgets.html)). What matters here is which runs the
gate must not touch, and where that judgement is made.

The per-workspace **monetary** spend budget meters and gates runs that cost the deployment money.
Two kinds of run incur **no** metered cost and so are **never** blocked by it:

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
spend", so a workspace at `0` refuses metered runs and keeps running local-runner models and
connected subscriptions. Treat it as a value to preserve rather than a missing configuration: the
temptation in any new gate is to read `0` as unset and fall back to a default limit, which would
silently start billing a workspace that opted out. The budget lives on the `workspace_settings`
row; there are no `SPEND_MONTHLY_LIMIT` / `SPEND_CURRENCY` env vars.

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

The variables themselves live in the canonical list,
[`docs/environment-variables.md`](../../docs/environment-variables.md) → Model providers, which the
website renders for operators. What is worth stating HERE is which of them changes a resolution
outcome, because that is what a change to this layer can break:

- **A provider key does not select a model; it makes a route USABLE.** `QWEN_API_KEY`,
  `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY` and `XAI_API_KEY` upgrade a dual-mode entry to its
  `direct` flavour by entering the capability set, not by being read at resolution time.
- **`AGENT_DEFAULT_*` and `AGENT_MODELS` are the LAST step of §3**, reached only when neither a
  block pin nor a workspace default answered.
- **`BEDROCK_REGION` registers the resolver; `BEDROCK_MODELS` is both its allow-list and the
  picker's enablement**, parsed once (below).
- **`ENCRYPTION_KEY` gates the subscription pool existing at all**: without it the
  vendor-credential endpoints answer `503`, so `hasSubscriptionToken` is structurally false and
  §4's override never fires.

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

- Using and configuring models (the user-facing authority):
  [catfactory.ai → Model Providers](https://www.catfactory.ai/guide/model-providers.html).
- Runtime flows (execution, merge lifecycle, requirements review):
  [`CLAUDE.md`](../../CLAUDE.md).
- Backend layering & the `GET /models` endpoint: [`backend/README.md`](../README.md).
- Spend safeguard: `@cat-factory/spend`.
- Self-hosted runner pool (where container steps dispatch off-Cloudflare):
  [`runner-pool-integration.md`](./runner-pool-integration.md).
