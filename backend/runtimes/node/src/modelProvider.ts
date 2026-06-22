import {
  CompositeModelProvider,
  InstrumentedModelProvider,
  type ProviderRegistry,
  baseProviderRegistry,
} from '@cat-factory/agents'
import type { ModelProvider } from '@cat-factory/kernel'
import { bedrockRegistry } from '@cat-factory/provider-bedrock'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  QWEN_BASE_URL,
} from '@cat-factory/agents'

// The Node deployment's ModelProvider: the shared base registry (direct vendors +
// Cloudflare-over-REST) plus opt-in AWS Bedrock when AWS credentials/region are set.
// There is no Workers AI binding on Node, so `workers-ai` is served via the
// Cloudflare REST resolver when CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set.

export function createNodeModelProvider(env: NodeJS.ProcessEnv): ModelProvider {
  // `||` not `??` on the base URLs: a set-but-blank env var must fall back to the
  // vendor default rather than collapse to an empty URL.
  const registry: ProviderRegistry = baseProviderRegistry({
    openaiApiKey: env.OPENAI_API_KEY,
    openaiBaseURL: env.OPENAI_BASE_URL || OPENAI_BASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openAiCompatible: {
      qwen: env.QWEN_API_KEY
        ? { apiKey: env.QWEN_API_KEY, baseURL: env.QWEN_BASE_URL || QWEN_BASE_URL }
        : undefined,
      deepseek: env.DEEPSEEK_API_KEY
        ? { apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL }
        : undefined,
      moonshot: env.MOONSHOT_API_KEY
        ? { apiKey: env.MOONSHOT_API_KEY, baseURL: env.MOONSHOT_BASE_URL || MOONSHOT_BASE_URL }
        : undefined,
    },
    cloudflareRest:
      env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN
        ? {
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: env.CLOUDFLARE_API_TOKEN,
            gateway: env.CLOUDFLARE_AI_GATEWAY,
          }
        : undefined,
  })

  const provider = new CompositeModelProvider(registry)

  // Opt-in Bedrock: registered only when a region is configured, so an unconfigured
  // deployment doesn't surface a half-wired provider.
  if (env.BEDROCK_REGION) {
    // An empty/blank list collapses to `undefined` (allow all) rather than `[]` — a
    // set-but-blank BEDROCK_MODELS must not silently reject every model (an empty
    // allow-list would). Only a non-empty list narrows the allow-list.
    const supportedModels = env.BEDROCK_MODELS?.split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    provider.register(
      bedrockRegistry({
        region: env.BEDROCK_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        supportedModels: supportedModels?.length ? supportedModels : undefined,
      }),
    )
  }

  // Opt-in Langfuse: wrap the provider so INLINE (non-proxied) calls — requirements
  // review/rework, the document planner, the fragment selector, the inline agent —
  // surface on the same trace sink the LLM proxy fans container calls out to. Off
  // unless `LANGFUSE_ENABLED=true` and both keys are set.
  if (
    env.LANGFUSE_ENABLED?.trim() === 'true' &&
    env.LANGFUSE_PUBLIC_KEY?.trim() &&
    env.LANGFUSE_SECRET_KEY?.trim()
  ) {
    return new InstrumentedModelProvider({
      inner: provider,
      traceSink: createLangfuseSink({
        publicKey: env.LANGFUSE_PUBLIC_KEY.trim(),
        secretKey: env.LANGFUSE_SECRET_KEY.trim(),
        baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
      }),
      recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false',
    })
  }

  return provider
}
