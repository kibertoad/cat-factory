import { type ProviderRegistry } from '@cat-factory/agents'
import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  QWEN_BASE_URL,
} from '@cat-factory/agents'
import type { ApiKeyService } from '@cat-factory/integrations'
import type { ModelProviderResolver } from '@cat-factory/kernel'
import { bedrockRegistry } from '@cat-factory/provider-bedrock'
import { cloudflareRestRegistry } from '@cat-factory/provider-cloudflare'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import { createScopedModelProviderResolver } from '@cat-factory/server'

// The Node deployment's ModelProvider RESOLVER: builds a per-scope provider from the
// DB-backed API-key pool (account/workspace/user), plus opt-in registries that need no
// per-scope key — AWS Bedrock (when AWS creds/region are set) and Cloudflare Workers AI
// over REST (when CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set). There is no
// Workers AI binding on Node, so `workers-ai` is served via the Cloudflare REST flavour.
// Inline calls are wrapped for Langfuse exactly like the proxied path when configured.

const NODE_BASE_URLS: Record<string, string> = {
  openai: OPENAI_BASE_URL,
  qwen: QWEN_BASE_URL,
  deepseek: DEEPSEEK_BASE_URL,
  moonshot: MOONSHOT_BASE_URL,
}

/** The base URL for a direct provider: env override (e.g. QWEN_BASE_URL), else default. */
function baseUrlForNode(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  // `||` not `??`: a set-but-blank override must fall back to the default.
  return env[`${provider.toUpperCase()}_BASE_URL`] || NODE_BASE_URLS[provider]
}

export function createNodeModelProviderResolver(
  env: NodeJS.ProcessEnv,
  apiKeys: ApiKeyService | undefined,
): ModelProviderResolver {
  const extraRegistries: ProviderRegistry[] = []

  // Opt-in Cloudflare Workers AI over REST.
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    extraRegistries.push(
      cloudflareRestRegistry({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        gateway: env.CLOUDFLARE_AI_GATEWAY,
      }),
    )
  }

  // Opt-in Bedrock: registered only when a region is configured.
  if (env.BEDROCK_REGION) {
    const supportedModels = env.BEDROCK_MODELS?.split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    extraRegistries.push(
      bedrockRegistry({
        region: env.BEDROCK_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        supportedModels: supportedModels?.length ? supportedModels : undefined,
      }),
    )
  }

  const instrument =
    env.LANGFUSE_ENABLED?.trim() === 'true' &&
    env.LANGFUSE_PUBLIC_KEY?.trim() &&
    env.LANGFUSE_SECRET_KEY?.trim()
      ? {
          traceSink: createLangfuseSink({
            publicKey: env.LANGFUSE_PUBLIC_KEY.trim(),
            secretKey: env.LANGFUSE_SECRET_KEY.trim(),
            baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
          }),
          recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false',
        }
      : undefined

  return createScopedModelProviderResolver({
    apiKeys,
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    extraRegistries,
    instrument,
  })
}
