# Candidate models — Cloudflare Workers AI

Purpose: a shortlist of **Cloudflare Workers AI** text models worth putting through
the benchmark harness (`cat-bench`, see [`README.md`](./README.md)), tiered by
price, with early — and explicitly **unverified** — guesses about which agent
roles each model suits. This is a _planning_ document to seed a benchmark matrix,
not a conclusion. Treat every "fit" verdict below as a hypothesis to confirm with
a graded run.

> Prices are Cloudflare Workers AI pay-as-you-go, **USD per 1M tokens**
> (input / output), as published June 2026. They drift — re-check before relying
> on the exact numbers. Source links at the bottom.

## Scope & exclusions

**Why Cloudflare-only.** The platform default provider is Workers AI (the `AI`
binding, always available, zero-config — see `CloudflareModelProvider` and
`domain/models.ts`). Direct provider keys (Anthropic / OpenAI / DashScope /
Moonshot / DeepSeek) are optional upgrades. This doc evaluates the _default_
surface: what we can run for everyone without a key.

**Excluded — expensive proprietary frontier** (per the brief): the
ChatGPT (GPT-4.x/5) and Claude (Opus/Sonnet) families, and by the same logic the
Gemini Pro tier. These are 1–2 orders of magnitude more expensive per token than
the open models below and aren't hosted on Workers AI anyway; they only enter as
direct-key "go premium" overrides, out of scope here. Note: OpenAI's **open-weight**
`gpt-oss` models _are_ on Workers AI and _are_ in scope — they are not ChatGPT.

**Excluded — superseded / old models** (brief: "only use latest"). Dropped from
candidacy and not benchmarked:

| Excluded model                                         | Superseded by                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `@cf/meta/llama-2-7b-chat-fp16`                        | Llama 3.2 / 3.3 / 4                                                                     |
| `@cf/meta/llama-3-8b-instruct` (+ `-awq`)              | `llama-3.2-3b`, `llama-4-scout`                                                         |
| `@cf/meta/llama-3.1-8b-instruct` (+ `-fp8/-awq/-fast`) | `llama-3.3-70b`, `llama-4-scout` — _but this is the current codebase default; see note_ |
| `@cf/meta/llama-3.1-70b-instruct-fp8-fast`             | `llama-3.3-70b-instruct-fp8-fast`                                                       |
| `@cf/mistral/mistral-7b-instruct-v0.1`                 | `mistral-small-3.1-24b`                                                                 |
| `@cf/google/gemma-3-12b-it`                            | `gemma-4-26b-a4b-it`                                                                    |
| `@cf/moonshotai/kimi-k2.5`                             | `kimi-k2.6` / `kimi-k2.7-code`                                                          |
| `@cf/qwen/qwq-32b`                                     | Qwen3 reasoning (`qwen3-30b-a3b`)                                                       |

> **Note on `llama-3.1-8b-instruct`:** it is still wired as the platform default
> (`models.ts:41`) and the generic Workers AI fallback. It is _old_ by this doc's
> bar; one outcome of benchmarking should be deciding its replacement as the
> always-on default (the leading candidate is `qwen3-30b-a3b-fp8`). Kept out of the
> candidate tiers, tracked here only as the incumbent baseline.

## The demand side — agent role workload profiles

Mapping needs a picture of what each role actually asks of a model. Roles are
defined in `backend/packages/agents/src/agents/*` and routed by
`agent-routing.ts`; container-operating roles run a real tool/agent loop inside a
Cloudflare Container (the Pi harness), the rest are inline LLM calls.

| Role                                     | Container? | Workload                                                                            | Demands                                                                               |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **coder** (build)                        | ✅         | Long autonomous agentic coding loop: edits files, opens/updates PRs, keeps CI green | **Highest.** Strong code gen, reliable multi-turn tool calling, long context, stamina |
| **architect** (design)                   | —          | Long-form solution design, components, trade-offs                                   | High reasoning, structured long-form prose                                            |
| **reviewer** (code review)               | —          | Assess a diff for correctness/security/risk, ordered findings                       | High reasoning over code, calibrated judgment, structured output                      |
| **playwright**                           | ✅         | Turn scenarios into runnable Playwright/framework tests                             | Mid-high code gen + tool calling                                                      |
| **mocker**                               | ✅         | Stand up WireMock stubs for external deps                                           | Mid code gen + tool calling                                                           |
| **business-documenter**                  | ✅         | Read a service, document domain rules to Markdown                                   | Mid: code comprehension, faithful writing                                             |
| **tester**                               | —          | Define high-value test cases by impact                                              | Mid reasoning                                                                         |
| **acceptance**                           | —          | Requirements → Given/When/Then scenarios                                            | Mid, structured output                                                                |
| **business-reviewer**                    | —          | Compare changes vs documented rules, flag drift                                     | Mid reasoning + recall                                                                |
| **blueprints**                           | ✅         | Emit canonical service→module→feature **JSON** tree                                 | Mid + **reliable structured/JSON output**                                             |
| **requirement-reviewer**                 | — (inline) | Generate review items (gaps/risks/questions) from requirements                      | Mid reasoning, structured output                                                      |
| **document-planner**                     | — (inline) | Extract board tree from imported docs (degrades to heading parser)                  | Low-mid, structured output                                                            |
| **researcher / documenter / integrator** | —          | One-shot research / docs / integration notes                                        | Low-mid                                                                               |
| **fragment-selector**                    | — (inline) | Pick relevant prompt fragments — tiny classification                                | **Lowest** — cheapest model wins                                                      |

Two clusters dominate cost: the **agentic container roles** (coder above all) where
quality and tool-call reliability justify spend, and the **high-volume cheap roles**
(fragment-selector, document-planner, the utility trio) where a nano model is the
right call.

## Candidate models by price tier

Capability notes blend Cloudflare's model cards with general knowledge; context
windows marked `~` are approximate and should be confirmed. ✅ = expected good fit,
⚠️ = usable but check, ❌ = expected poor fit, 💸 = **flagged poor price/quality**.

### Tier 0 — Nano / ultra-cheap (≤ ~$0.10 in, ≤ ~$0.40 out)

Trivial, high-frequency, or latency-sensitive work. Don't expect agentic stamina.

| Model                                 | In / Out        | Notes                                                                         | Early role fit                                                                                                                                                                 |
| ------------------------------------- | --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@cf/ibm-granite/granite-4.0-h-micro` | $0.017 / $0.112 | Tiny hybrid-Mamba, tool calling, long ctx, very fast                          | ✅ fragment-selector ✅ document-planner ❌ coder/reviewer                                                                                                                     |
| `@cf/meta/llama-3.2-3b-instruct`      | $0.051 / $0.335 | Small dense, latest small Llama                                               | ✅ fragment-selector ⚠️ utility trio ❌ anything agentic                                                                                                                       |
| `@cf/qwen/qwen3-30b-a3b-fp8`          | $0.051 / $0.335 | **MoE, 3B active**, ~256K ctx, reasoning toggle, tool calling. Standout value | ✅✅ default for most roles: tester, acceptance, requirement-reviewer, blueprints, researcher/documenter/integrator; ⚠️ reviewer/architect (try it); ⚠️ coder (cheap baseline) |
| `@cf/zai-org/glm-4.7-flash`           | $0.060 / $0.400 | 131K ctx, **multi-turn tool calling**, agentic-oriented, fast                 | ✅ mocker, playwright (light), blueprints, document-planner; ⚠️ coder (budget agentic baseline)                                                                                |
| `@cf/google/gemma-4-26b-a4b-it`       | $0.100 / $0.300 | **MoE (~4B active)**, latest Gemma, cheap output                              | ✅ tester, acceptance, business-documenter, utility trio; ⚠️ reviewer                                                                                                          |

`llama-3.2-1b` ($0.027/$0.201) exists but is below the quality floor for every role
except possibly fragment-selector; skip in favour of `granite-4.0-h-micro`.

### Tier 1 — Mid / workhorse (~$0.20–0.70 in, ~$0.30–1.50 out)

The sweet spot for inline reasoning roles and lighter container work.

| Model                                          | In / Out        | Notes                                                         | Early role fit                                                                                         |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@cf/openai/gpt-oss-20b`                       | $0.200 / $0.300 | OpenAI open-weight, reasoning + tool use, ~128K, cheap output | ✅ reviewer, architect (value), tester, business-reviewer, requirement-reviewer; ⚠️ coder (light)      |
| `@cf/meta/llama-4-scout-17b-16e-instruct`      | $0.270 / $0.850 | **MoE 17Bx16e**, very long ctx, multimodal, tool use          | ⚠️ business-documenter, document-planner (long inputs); ⚠️ reviewer; ❌ heavy coder                    |
| `@cf/openai/gpt-oss-120b`                      | $0.350 / $0.750 | OpenAI open-weight flagship-open, strong reasoning + tool use | ✅✅ reviewer, architect; ✅ coder (mid-tier agentic candidate), business-reviewer                     |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | $0.351 / $0.555 | Dense 24B, tool use, vision, ~128K                            | ✅ tester, acceptance, mocker, documenter; ⚠️ reviewer                                                 |
| `@cf/nvidia/nemotron-3-120b-a12b`              | $0.500 / $1.500 | **MoE 120B/12B active**, reasoning-tuned                      | ⚠️ architect, reviewer (try vs gpt-oss-120b); ⚠️ coder                                                 |
| `@cf/qwen/qwen2.5-coder-32b-instruct`          | $0.660 / $1.000 | Coding-specialist (prev gen), tool use                        | ⚠️ playwright, mocker, coder (coding-focused but older gen — confirm it still beats Qwen3-30B on code) |

`gemma-sea-lion-v4-27b-it` ($0.351/$0.555) is SE-Asian-language specialised; skip
unless multilingual coverage becomes a requirement.

### Tier 2 — Premium open (agentic flagships) (~$0.50–1.40 in, ~$3–4.40 out)

Reserve for the hardest agentic work — chiefly **coder**, where reliability pays
for itself. Output tokens get expensive fast here; watch long autonomous loops.

| Model                                          | In / Out            | Notes                                                                                                                         | Early role fit                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cf/moonshotai/kimi-k2.7-code`                | $0.950 / $4.000     | **1T-param MoE, coding-tuned**, ~262K ctx, multi-turn tool calling, structured outputs                                        | ✅✅ coder (top candidate); ✅ playwright; ⚠️ architect (pricey for prose)                                                                                                                                      |
| `@cf/zai-org/glm-5.2`                          | $1.400 / $4.400     | **Agentic coding flagship**, ~256K ctx, function calling. _Current agentic default_ (`architect/coder/reviewer`, `agents.ts`) | ✅✅ coder; ✅ architect, reviewer — but most expensive input; justify vs gpt-oss-120b and Kimi                                                                                                                 |
| `@cf/moonshotai/kimi-k2.6`                     | $0.950 / $4.000     | General frontier-scale agentic (non-code variant). _Current pickable `kimi` (`models.ts:58`)_                                 | ⚠️ coder/architect — likely dominated by `k2.7-code` at the same price for our coding-heavy work                                                                                                                |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | $0.497 / **$4.881** | 💸 R1-distill reasoning. _Current pickable `deepseek` (`models.ts:69`)_                                                       | 💸 **Poor price/quality**: a 32B _distill_ priced like a frontier model on output, no real tool-use story for agentic loops. ❌ coder. At most ⚠️ reviewer/architect — and gpt-oss-120b is cheaper and stronger |

## Flagged: poor price/quality (deprioritise or drop)

- 💸 **`deepseek-r1-distill-qwen-32b`** — `$4.881` output is the most expensive in
  the whole catalog, for a _distilled 32B_. It is the current pickable `deepseek`
  model; recommend replacing the Workers AI flavour with `gpt-oss-120b` (cheaper,
  stronger, real tool use) unless a benchmark proves the distill's reasoning wins
  decisively on reviewer-type tasks.
- ⚠️💸 **`llama-3.3-70b-instruct-fp8-fast`** ($0.293 / $2.253) — included implicitly
  as the "latest Llama 70B," but dense-70B output pricing is beaten on
  price _and_ likely quality by the MoE options (`gpt-oss-120b`, `nemotron-3`,
  `qwen3-30b`). Benchmark only if a Llama baseline is explicitly wanted; otherwise
  skip. (`llama-3.1-70b` at the same price is excluded as older.)
- ⚠️ **`kimi-k2.6`** — same price as the coding-tuned `kimi-k2.7-code`; for this
  product's coding-heavy roles the `-code` variant should dominate. Keep k2.6 only
  if a non-code general agentic comparison is wanted.
- ⚠️ **`qwen2.5-coder-32b`** — previous-generation coder at $0.66/$1.00. Must prove
  it still beats the far cheaper `qwen3-30b-a3b` on code before earning a slot.

## Suggested first benchmark matrix

Keep the first `cat-bench` run small and decision-oriented. The harness already
benchmarks three tasks — `requirement-review`, `code-review`, `implementation`
(`benchmark-harness/src/types.ts`) — which map to the **requirement-reviewer**,
**reviewer**, and **coder** roles. Proposed candidates per task:

- **implementation (coder):** `glm-5.2` (incumbent agentic default) vs
  `kimi-k2.7-code` vs `gpt-oss-120b` vs — as a value long-shot — `qwen3-30b-a3b`.
- **code-review (reviewer):** `gpt-oss-120b` vs `gpt-oss-20b` vs `qwen3-30b-a3b`
  vs `glm-5.2`. (Settles whether reviewer needs a premium model at all.)
- **requirement-review:** `qwen3-30b-a3b` vs `gpt-oss-20b` vs `gemma-4-26b-a4b`
  vs `glm-4.7-flash`. (All cheap; find the quality floor.)

Headline questions to answer: (1) can `qwen3-30b-a3b` replace `llama-3.1-8b` as the
always-on default? (2) does `glm-5.2`'s premium beat `gpt-oss-120b` / `kimi-k2.7-code`
enough to stay the coder default? (3) is a premium model justified for **reviewer**,
or does a Tier-0/1 model suffice?

## Sources

- [Workers AI Models · Cloudflare docs](https://developers.cloudflare.com/workers-ai/models/)
- [Workers AI pricing · Cloudflare docs](https://developers.cloudflare.com/workers-ai/platform/pricing/) (per-model table mirrored from the docs source)
- [Introducing GLM-4.7-Flash on Workers AI · Cloudflare Changelog](https://developers.cloudflare.com/changelog/post/2026-02-13-glm-47-flash-workers-ai/)
- [glm-4.7-flash model card · Cloudflare docs](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/)
- [Cloudflare Workers AI pricing 2026 · CostBench](https://costbench.com/software/llm-api-providers/cloudflare-workers-ai/)
- [Cloudflare Workers AI models & benchmarks · CloudPrice](https://cloudprice.net/models/providers/cloudflare_workers_ai)
- [Cloudflare Workers AI pricing breakdown · Markaicode](https://markaicode.com/pricing/cloudflare-workers-pricing-breakdown/)
  </content>
  </invoke>
