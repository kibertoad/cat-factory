import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelProvider, ModelRef } from '@cat-factory/core'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import type { Env } from '../env'

/**
 * Resolves a provider-agnostic {@link ModelRef} into a concrete Vercel AI SDK
 * model. This is the infrastructure binding of the LLM seam: the core asks for
 * `{ provider: 'openai', model: 'gpt-4o-mini' }` and gets back something
 * `generateText` can call, while API keys and the Workers AI binding stay here.
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
