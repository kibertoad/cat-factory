import {
  CompositeModelProvider,
  type ModelResolver,
  type ProviderRegistry,
  anthropicResolver,
  openAiCompatibleResolver,
  openAiResolver,
} from '@cat-factory/agents'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import type { Env } from '../env'
import { baseUrlFor } from './providerEndpoints'

// DashScope (Alibaba), DeepSeek and Moonshot (Kimi) all expose OpenAI-compatible
// chat APIs, so they resolve through the openai-compatible provider with just a
// base URL and a key (see ./providerEndpoints for the shared base URLs).
// DashScope's international endpoint is used (the mainland host differs).

/**
 * Build the Worker's base provider registry. `workers-ai` is the Cloudflare flavour
 * (resolved via the in-process `AI` binding); `openai`/`anthropic` and the
 * OpenAI-compatible vendors (`qwen`/`deepseek`/`moonshot`) are keyed from `env`. A
 * provider is registered ONLY when its credential/binding is present, so an unconfigured
 * provider resolves to a clear "Unsupported model provider" error (from
 * {@link CompositeModelProvider}) rather than failing deep in the vendor SDK — matching the
 * Node facade exactly (the conditional `baseProviderRegistry`), so the two runtimes don't
 * diverge on a missing key.
 */
function workerBaseRegistry(env: Env): ProviderRegistry {
  const compatible = (
    provider: 'qwen' | 'deepseek' | 'moonshot',
    apiKey: string | undefined,
  ): ModelResolver | undefined =>
    apiKey
      ? openAiCompatibleResolver({ name: provider, apiKey, baseURL: baseUrlFor(provider, env)! })
      : undefined

  return {
    openai: env.OPENAI_API_KEY ? openAiResolver({ apiKey: env.OPENAI_API_KEY }) : undefined,
    anthropic: env.ANTHROPIC_API_KEY
      ? anthropicResolver({ apiKey: env.ANTHROPIC_API_KEY })
      : undefined,
    qwen: compatible('qwen', env.QWEN_API_KEY),
    deepseek: compatible('deepseek', env.DEEPSEEK_API_KEY),
    moonshot: compatible('moonshot', env.MOONSHOT_API_KEY),
    'workers-ai': env.AI
      ? (ref) => {
          const binding = env.AI
          if (!binding) throw new Error('Workers AI binding (AI) is not configured')
          // workers-ai-provider@3 implements the same provider spec as `ai` v6
          // (`@ai-sdk/provider` v3), so the model is a real LanguageModel — no cast.
          const workersai = createWorkersAI({ binding })
          return workersai(ref.model as Parameters<typeof workersai>[0])
        }
      : undefined,
  }
}

/**
 * Resolves a provider-agnostic {@link ModelRef} into a concrete Vercel AI SDK model.
 * This is the Worker's binding of the LLM seam: the core asks for
 * `{ provider: 'openai', model: 'gpt-4o-mini' }` and gets back something `generateText`
 * can call, while API keys and the Workers AI binding stay here.
 *
 * It is just the Worker's composition of the shared AI provisioning facade
 * ({@link CompositeModelProvider}): the base registry above plus any `extraRegistries`
 * an installation mixes in — e.g. `bedrockRegistry()` from `@cat-factory/provider-bedrock`.
 */
export class CloudflareModelProvider implements ModelProvider {
  private readonly composite: CompositeModelProvider

  constructor({ env, extraRegistries = [] }: { env: Env; extraRegistries?: ProviderRegistry[] }) {
    this.composite = new CompositeModelProvider(workerBaseRegistry(env), ...extraRegistries)
  }

  resolve(ref: ModelRef): LanguageModel {
    return this.composite.resolve(ref)
  }
}
