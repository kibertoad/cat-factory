import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelProvider, ModelRef } from '@cat-factory/core'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import type { Env } from '../env'

// DashScope (Alibaba), DeepSeek and Moonshot (Kimi) all expose OpenAI-compatible
// chat APIs, so they resolve through the openai-compatible provider with just a
// base URL and a key. DashScope's international endpoint is used (the mainland
// host differs).
const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'

/**
 * Resolves a provider-agnostic {@link ModelRef} into a concrete Vercel AI SDK
 * model. This is the infrastructure binding of the LLM seam: the core asks for
 * `{ provider: 'openai', model: 'gpt-4o-mini' }` and gets back something
 * `generateText` can call, while API keys and the Workers AI binding stay here.
 *
 * `workers-ai` is the Cloudflare flavour (used as the fallback for every model);
 * `qwen`, `deepseek` and `moonshot` are the direct-provider flavours, selected
 * automatically when their API key is configured.
 */
export class CloudflareModelProvider implements ModelProvider {
  private readonly env: Env

  constructor({ env }: { env: Env }) {
    this.env = env
  }

  resolve(ref: ModelRef): LanguageModel {
    switch (ref.provider) {
      case 'openai':
        return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(ref.model)
      case 'anthropic':
        return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(ref.model)
      case 'qwen': {
        if (!this.env.QWEN_API_KEY) {
          throw new Error('QWEN_API_KEY is not configured')
        }
        return createOpenAICompatible({
          name: 'qwen',
          apiKey: this.env.QWEN_API_KEY,
          baseURL: QWEN_BASE_URL,
        })(ref.model)
      }
      case 'deepseek': {
        if (!this.env.DEEPSEEK_API_KEY) {
          throw new Error('DEEPSEEK_API_KEY is not configured')
        }
        return createOpenAICompatible({
          name: 'deepseek',
          apiKey: this.env.DEEPSEEK_API_KEY,
          baseURL: DEEPSEEK_BASE_URL,
        })(ref.model)
      }
      case 'moonshot': {
        if (!this.env.MOONSHOT_API_KEY) {
          throw new Error('MOONSHOT_API_KEY is not configured')
        }
        return createOpenAICompatible({
          name: 'moonshot',
          apiKey: this.env.MOONSHOT_API_KEY,
          baseURL: MOONSHOT_BASE_URL,
        })(ref.model)
      }
      case 'workers-ai': {
        if (!this.env.AI) {
          throw new Error('Workers AI binding (AI) is not configured')
        }
        // workers-ai-provider pins a slightly older @ai-sdk/provider than `ai`
        // v5; the runtime is compatible, so bridge the type-only skew with a cast.
        const workersai = createWorkersAI({ binding: this.env.AI })
        return workersai(ref.model as Parameters<typeof workersai>[0]) as unknown as LanguageModel
      }
      default:
        throw new Error(`Unsupported model provider: ${ref.provider}`)
    }
  }
}
