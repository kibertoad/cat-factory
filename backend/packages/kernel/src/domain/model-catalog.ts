import type { SelectableModel } from './models.js'

// The curated catalog of LLM models a user can pick for a single block: DATA ONLY.
//
// Split out of `models.ts`, which owns the vocabulary this array is typed against
// (`SelectableModel` and the per-flavour variant shapes) and every rule that READS it
// (flavour precedence, family policy, subscription/harness resolution). The two grow for
// unrelated reasons: this file changes whenever a vendor ships a model, that one whenever
// the resolution rules change. Keeping them apart means a routine catalog addition cannot
// push the resolution logic over its size budget, and a reviewer of either sees only the
// concern they came for.
//
// `models.ts` re-exports `MODEL_CATALOG`, so every existing import site is unchanged and
// there is one public name for the catalog rather than two.
//
// The import above is TYPE-ONLY and erases at compile time, so the file pair carries no
// runtime import cycle.
//
// Each model declares one flavour per route it can be reached on (see `MODEL_FLAVORS`): an
// always-available Cloudflare Workers AI variant (via the `AI` binding); a `direct` variant
// for models that offer their own API; a `bedrock` variant for models an AWS account can
// call on Bedrock; an `openrouter` variant reaching the same model through the OpenRouter
// gateway; and a `subscription` variant. `effectiveVariant` resolves the flavour actually in
// use per workspace by walking `DEFAULT_PROVIDER_PREFERENCE`, so connecting an OpenRouter key
// (with no native direct key) transparently routes the model through OpenRouter while a
// native direct key still wins. This makes "go direct / go gateway" a zero-config upgrade
// with an automatic Cloudflare fallback.
//
// A flavour is declared only once the route is VERIFIED to serve that exact model: a
// declared-but-absent route is picked by `effectiveVariant` and then fails at dispatch, and
// mapping an entry onto a NEIGHBOURING version (GLM-5.2 onto Bedrock's GLM-5, Kimi K2.6 onto
// Bedrock's K2.5) silently runs a different model than the picker names.

export const MODEL_CATALOG: SelectableModel[] = [
  {
    id: 'cloudflare-llama',
    family: 'llama',
    label: 'Llama 4 Scout',
    description:
      "Meta's 17B-active MoE with a 131K window and tool calling — Cloudflare Workers AI's " +
      'open-weights default.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      contextTokens: 131_072,
      acceptsImages: true,
    },
  },
  {
    id: 'qwen',
    family: 'qwen',
    label: 'Qwen3.7',
    description:
      "Alibaba's Qwen — Qwen3-30B on Cloudflare, flagship Qwen3.7-Max (1M context) when " +
      'direct or through OpenRouter.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      contextTokens: 32_768,
    },
    direct: {
      ref: { provider: 'qwen', model: 'qwen3.7-max', contextTokens: 1_000_000 },
      keyEnv: 'QWEN_API_KEY',
      providerLabel: 'DashScope',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'qwen/qwen3.7-max', contextTokens: 1_000_000 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'gpt-oss-120b',
    family: 'openai',
    label: 'GPT-OSS 120B',
    description:
      "OpenAI's open-weights 120B reasoning model with tool calling and a 128K window — the " +
      'strongest general-purpose model on Cloudflare that carries no vendor subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/openai/gpt-oss-120b',
      contextTokens: 128_000,
    },
    bedrock: { baseModelId: 'openai.gpt-oss-120b', contextTokens: 131_072 },
    openrouter: {
      ref: { provider: 'openrouter', model: 'openai/gpt-oss-120b', contextTokens: 131_072 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'kimi-k2.7',
    family: 'kimi',
    label: 'Kimi K2.7',
    description:
      "Moonshot AI's latest 1T-param agentic-coding model (structured outputs), 256K context — " +
      'on Cloudflare or pay-as-you-go through OpenRouter (billed at Moonshot rates).',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.7-code',
      contextTokens: 262_144,
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', contextTokens: 262_144 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'kimi',
    family: 'kimi',
    label: 'Kimi K2.6',
    description:
      "Moonshot AI's frontier-scale agentic model with a 256K context, on Cloudflare or " +
      'direct via a Moonshot key / Kimi (Moonshot) subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.6',
      contextTokens: 262_144,
    },
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k2.6', contextTokens: 262_144 },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
    // Run via Claude Code against Moonshot's Anthropic-compatible endpoint on a
    // Kimi coding-plan subscription (same 256K window, flat-rate quota).
    subscription: {
      ref: {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        harness: 'claude-code',
        contextTokens: 262_144,
      },
      vendor: 'kimi',
    },
  },
  {
    id: 'kimi-k3',
    family: 'kimi',
    label: 'Kimi K3',
    description:
      "Moonshot AI's 2.8T-param flagship — 1M-token context, always-on reasoning — direct via " +
      'a Moonshot key or pay-as-you-go through OpenRouter. Not served on Workers AI.',
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k3', contextTokens: 1_048_576 },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'moonshotai/kimi-k3', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'deepseek',
    family: 'deepseek',
    label: 'DeepSeek V4 Flash',
    description:
      "DeepSeek's cost-efficient 1M-context V4 model when direct, through OpenRouter or on a " +
      'DeepSeek coding-plan subscription; falls back to the 80K R1 Qwen-32B distill on Cloudflare.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      contextTokens: 80_000,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-v4-flash', contextTokens: 1_048_576 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        contextTokens: 1_048_576,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    // Run via Claude Code against DeepSeek's Anthropic-compatible endpoint on a
    // DeepSeek coding-plan subscription (full context, flat-rate quota).
    subscription: {
      ref: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        harness: 'claude-code',
        contextTokens: 1_048_576,
      },
      vendor: 'deepseek',
    },
  },
  {
    id: 'deepseek-v4-pro',
    family: 'deepseek',
    label: 'DeepSeek V4 Pro',
    description:
      "DeepSeek's flagship V4 Pro agentic-coding model: 131K context on Cloudflare, or the " +
      'full 1M window direct via a DeepSeek key or through OpenRouter.',
    // A Cloudflare AI-catalog model: a `<provider>/<model>` slug (not a native `@cf/...`
    // id) Cloudflare serves on its unified-billing run catalog via a partner (Fireworks),
    // reached with the account's own Workers AI binding/token — no AI Gateway, no BYOK.
    // The Worker runs it through `binding.run` directly (see WorkersAiLlmUpstream).
    cloudflare: {
      provider: 'workers-ai',
      model: 'deepseek/deepseek-v4-pro',
      contextTokens: 131_072,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-v4-pro', contextTokens: 1_048_576 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'glm-5.3',
    family: 'glm',
    label: 'GLM-5.3',
    description:
      "Z.ai's newest agentic-coding model, on the same base as GLM-5.2 with scaled-up " +
      'post-training. Subscription-only here: it runs on a GLM (Z.ai) coding-plan token, ' +
      'which is the only route serving it today.',
    // Z.ai shipped GLM-5.3 on 2026-08-14 to its own API and to every existing GLM Coding
    // Plan subscriber, and states the weights follow in roughly two weeks after safety
    // hardening. That timing is why this entry declares NO other flavour: Workers AI and
    // OpenRouter both serve GLM from the open weights, so neither can carry 5.3 until the
    // release lands, and Bedrock's Z.ai line stops at GLM-5. A flavour declared before its
    // route exists would be picked by `effectiveVariant` and fail at dispatch, so each one
    // is added when the route is verified rather than when it is expected.
    //
    // Context is the 1M window GLM-5.2 carries on the same base model; Z.ai has not yet
    // published a 5.3 model card, so nothing narrower is asserted here.
    subscription: {
      ref: { provider: 'zai', model: 'glm-5.3', harness: 'claude-code', contextTokens: 1_000_000 },
      vendor: 'glm',
    },
  },
  {
    id: 'glm',
    family: 'glm',
    label: 'GLM-5.2',
    description:
      "Z.ai's agentic-coding model: 256K context on Cloudflare, or the full 1M-token " +
      'window via a GLM (Z.ai) subscription.',
    cloudflare: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2', contextTokens: 262_144 },
    openrouter: {
      ref: { provider: 'openrouter', model: 'z-ai/glm-5.2', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    // Run via Claude Code against Z.ai's Anthropic-compatible endpoint on a GLM
    // coding-plan subscription (full 1M context, flat-rate quota).
    subscription: {
      ref: { provider: 'zai', model: 'glm-5.2', harness: 'claude-code', contextTokens: 1_000_000 },
      vendor: 'glm',
    },
  },
  {
    id: 'glm-flash',
    family: 'glm',
    label: 'GLM-4.7 Flash',
    description:
      "Z.ai's cheap, fast tool-calling model with a 131K window — the low-cost tier for light " +
      'inline steps (estimation, triage, fragment selection).',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      contextTokens: 131_072,
    },
    // Bedrock serves this exact model as `zai.glm-4.7-flash` (us-east-1 / us-west-2 and
    // expanding). No `contextTokens`: AWS publishes no window for it, and the field means
    // "known at Bedrock" rather than "copied from another route", so it stays absent and
    // the ref falls back to the entry's default rather than asserting Cloudflare's 131K
    // or OpenRouter's 202K for a serving stack that is neither.
    bedrock: { baseModelId: 'zai.glm-4.7-flash' },
    openrouter: {
      ref: { provider: 'openrouter', model: 'z-ai/glm-4.7-flash', contextTokens: 202_752 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  // Subscription-only models: run in the Claude Code / Codex harness with a pooled
  // subscription token (Claude Pro/Max, ChatGPT Plus/Pro), direct to the vendor.
  {
    id: 'claude-fable',
    family: 'claude',
    label: 'Claude Fable 5',
    description:
      "Anthropic's most capable model — run via Claude Code on your Claude subscription, " +
      'or pay-as-you-go through OpenRouter (billed at Anthropic rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'anthropic/claude-fable-5',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-fable-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-opus',
    family: 'claude',
    label: 'Claude Opus 5',
    description:
      "Anthropic's flagship agentic-coding model — a step change over Opus 4.8 at the " +
      'same price, run via Claude Code on your Claude subscription, or pay-as-you-go ' +
      'through OpenRouter (billed at Anthropic rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-sonnet',
    family: 'claude',
    label: 'Claude Sonnet 5',
    description:
      "Anthropic's balanced speed/intelligence model with a 1M-token context, run via Claude " +
      'Code. Subscription-only here; the pay-as-you-go route is the dynamic OpenRouter catalog.',
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-opus-4-8',
    family: 'claude',
    label: 'Claude Opus 4.8 (Bedrock)',
    description:
      "Anthropic's previous-generation flagship, on AWS Bedrock in your own account and " +
      'Region: the residency-guaranteed route for Claude work. Bedrock lags Anthropic; ' +
      'Opus 5 is subscription/OpenRouter only.',
    // Bedrock-ONLY on purpose. This is a different MODEL from `claude-opus`, not another
    // route to it, so it is its own entry: folding a `bedrock` flavour onto `claude-opus`
    // would silently run 4.8 for a block pinned to 5. No `contextTokens`: Bedrock's window
    // for this model is per-account and we have none verified, and an invented number would
    // cap the proxy's output budget against a limit nobody measured.
    bedrock: { baseModelId: 'anthropic.claude-opus-4-8', acceptsImages: true },
  },
  // The GPT-5.6 tiers are what Codex actually serves today: `sol` (flagship), `terra`
  // (balanced everyday) and `luna` (cheapest). The model id IS the Codex `--model` slug —
  // the `-codex` suffixed family ended at GPT-5.3, so a `gpt-5.5-codex`-shaped id makes the
  // CLI fail with `Unknown model`. GPT-5.5 stays as the previous-generation frontier tier.
  {
    id: 'gpt-5.6-sol',
    family: 'openai',
    label: 'GPT-5.6 Sol',
    description:
      "OpenAI's flagship for complex coding and research — run via Codex on your ChatGPT " +
      'subscription, or pay-as-you-go through OpenRouter (billed at OpenAI rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.6-terra',
    family: 'openai',
    label: 'GPT-5.6 Terra',
    description:
      "OpenAI's balanced everyday model — GPT-5.5-class capability at a fraction of the cost. " +
      'The migration target for GPT-5.4, which Codex retires on 31 Aug 2026.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-terra',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.6-luna',
    family: 'openai',
    label: 'GPT-5.6 Luna',
    description:
      "OpenAI's fastest, cheapest GPT-5.6 tier — for clear, repeatable tasks. The migration " +
      'target for GPT-5.4 mini.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-luna',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.5',
    family: 'openai',
    label: 'GPT-5.5',
    description:
      "OpenAI's previous-generation frontier model, still served by Codex — run on your " +
      'ChatGPT subscription, pay-as-you-go through OpenRouter (billed at OpenAI rates), or ' +
      'on AWS Bedrock. The newest OpenAI generation Bedrock serves: the GPT-5.6 tiers are ' +
      'Codex/OpenRouter only.',
    bedrock: { baseModelId: 'openai.gpt-5.5', contextTokens: 1_050_000, acceptsImages: true },
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.5',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.5',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  // Gemini has no Cloudflare/native-direct flavour in this deployment, so it is reached
  // through the OpenRouter gateway (billed at Google's rates, no markup). It becomes
  // selectable once an OpenRouter API key is connected for the workspace/user.
  // Other vendors' OpenRouter routes are folded into their native catalog entries (see
  // `openrouter` flavour on deepseek/gpt-5.5/claude-opus); any model not curated here is
  // reachable via the dynamic per-workspace OpenRouter catalog (`openRouterSelectableModels`).
  {
    id: 'gemini',
    family: 'gemini',
    label: 'Gemini 3.1 Pro',
    description:
      "Google's flagship Gemini Pro via OpenRouter — 1M-token context, billed at Google rates. " +
      'Still the newest Pro: 3.5 Pro has slipped repeatedly and the 3.x Pro line stops here.',
    openrouter: {
      ref: {
        // The `-preview` suffix is NOT staleness: 3.1 Pro is GA and Google kept the suffix
        // in the API id, so this IS the generally-available flagship. Do not "fix" it to
        // `google/gemini-3.1-pro` — that slug does not exist, and pinning it would recreate
        // the dead-id failure this catalog was just swept for. (2.5 Pro is the misleading
        // precedent: it has both a GA and a `-preview` slug, 3.1 Pro only the latter.)
        // `google/gemini-pro-latest` is likewise deliberately unused — a floating alias
        // would swap the model under a pinned block with no version change to review.
        provider: 'openrouter',
        model: 'google/gemini-3.1-pro-preview',
        contextTokens: 1_048_576,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'gemini-3.7-flash',
    family: 'gemini',
    label: 'Gemini 3.7 Flash',
    description:
      "Google's newest workhorse: 1M-token context, 64K output, and a large coding and " +
      'agentic step over 3.6 Flash at the same list price. Via OpenRouter, billed at ' +
      'Google rates.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
        contextTokens: 1_048_576,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'gemini-flash',
    family: 'gemini',
    label: 'Gemini 3.6 Flash',
    description:
      "Google's newest model and its positioned workhorse — 1M-token context at a fraction of " +
      'Pro pricing. Via OpenRouter, billed at Google rates.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'google/gemini-3.6-flash',
        contextTokens: 1_048_576,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'grok',
    family: 'grok',
    label: 'Grok 4.6',
    description:
      "xAI's frontier model for long-running agents and agentic coding: a 500K window with " +
      'image input, direct via an xAI key or pay-as-you-go through OpenRouter.',
    direct: {
      ref: {
        provider: 'xai',
        model: 'grok-4.6',
        contextTokens: 500_000,
        acceptsImages: true,
      },
      keyEnv: 'XAI_API_KEY',
      providerLabel: 'xAI',
    },
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'x-ai/grok-4.6',
        contextTokens: 500_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    // No `bedrock` arm: AWS's xAI line stops at Grok 4.3, a different model. No `cloudflare`
    // arm either, so this entry has no always-available floor and goes unavailable when
    // neither key is set, which is the honest reading of a closed-weights vendor.
  },
  // LiteLLM — an operator-hosted OpenAI-compatible gateway. Model names are defined by the
  // operator's LiteLLM `config.yaml` (`model_name`), so this generic entry assumes a
  // `gpt-4o` route; rename the model (or pin via AGENT_DEFAULT_MODEL) to match your
  // gateway. Selectable once a LiteLLM API key is connected AND LITELLM_BASE_URL is set.
  {
    id: 'litellm-default',
    label: 'LiteLLM (gateway default)',
    description: "Your LiteLLM gateway's `gpt-4o` route — rename to match your config.yaml.",
    direct: {
      ref: { provider: 'litellm', model: 'gpt-4o', contextTokens: 128_000 },
      keyEnv: 'LITELLM_API_KEY',
      providerLabel: 'LiteLLM',
    },
  },
]
