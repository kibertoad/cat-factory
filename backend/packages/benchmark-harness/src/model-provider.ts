import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelProvider, ModelRef } from '@cat-factory/core'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'

// A Node-side ModelProvider — the embeddable twin of the worker's
// CloudflareModelProvider. It resolves the same provider-agnostic ModelRefs to
// concrete Vercel AI SDK models, but runs *outside* workerd: direct providers
// use their API keys from the environment, and `workers-ai` is reached through
// the Cloudflare REST API (account id + token) rather than the Worker `AI`
// binding — so the whole harness can run locally while still using Cloudflare
// Workers AI.

const DEFAULT_BASE_URLS: Record<string, string> = {
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  openai: 'https://api.openai.com/v1',
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is not set (required to resolve this model)`)
  return value
}

export interface NodeModelProviderOptions {
  env?: NodeJS.ProcessEnv
}

export class NodeModelProvider implements ModelProvider {
  private readonly env: NodeJS.ProcessEnv

  constructor(options: NodeModelProviderOptions = {}) {
    this.env = options.env ?? process.env
  }

  resolve(ref: ModelRef): LanguageModel {
    switch (ref.provider) {
      case 'openai':
        return createOpenAI({
          apiKey: requireEnv(this.env, 'OPENAI_API_KEY'),
          baseURL: this.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URLS.openai,
        })(ref.model)
      case 'anthropic':
        return createAnthropic({ apiKey: requireEnv(this.env, 'ANTHROPIC_API_KEY') })(ref.model)
      case 'qwen':
        return createOpenAICompatible({
          name: 'qwen',
          apiKey: requireEnv(this.env, 'QWEN_API_KEY'),
          baseURL: this.env.QWEN_BASE_URL ?? DEFAULT_BASE_URLS.qwen!,
        })(ref.model)
      case 'deepseek':
        return createOpenAICompatible({
          name: 'deepseek',
          apiKey: requireEnv(this.env, 'DEEPSEEK_API_KEY'),
          baseURL: this.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URLS.deepseek!,
        })(ref.model)
      case 'moonshot':
        return createOpenAICompatible({
          name: 'moonshot',
          apiKey: requireEnv(this.env, 'MOONSHOT_API_KEY'),
          baseURL: this.env.MOONSHOT_BASE_URL ?? DEFAULT_BASE_URLS.moonshot!,
        })(ref.model)
      case 'workers-ai': {
        // REST mode: no Worker binding, just the account id + an API token with
        // Workers AI access. This is the "local + Cloudflare AI" path.
        const workersai = createWorkersAI({
          accountId: requireEnv(this.env, 'CF_ACCOUNT_ID'),
          apiKey: requireEnv(this.env, 'CF_API_TOKEN'),
        })
        return workersai(ref.model as Parameters<typeof workersai>[0])
      }
      default:
        throw new Error(`Unsupported model provider: ${ref.provider}`)
    }
  }
}
