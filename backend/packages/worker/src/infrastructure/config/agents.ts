import type { AgentKind } from '@cat-factory/contracts'
import {
  type AgentModelConfig,
  type AgentRouting,
  type ModelRef,
  resolveModelRef,
} from '@cat-factory/core'
import type { Env } from '../env'
import { num } from './utils'

export interface AgentsConfig {
  /**
   * Route the repo-operating steps (`coder`, plus the `mocker` mock builder and
   * `playwright` e2e writer) to a per-run Cloudflare Container running the Pi
   * coding agent, rather than a single inline LLM call. Requires `enabled` plus
   * the container binding / GitHub / proxy wiring (see container.ts).
   */
  containerImpl: boolean
  routing: AgentRouting
  /**
   * Resolve a block's selected model id to a concrete ref, honouring the
   * direct/Cloudflare fallback based on which provider keys are configured.
   */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
}

function parseModelOverrides(
  raw: string | undefined,
): Partial<Record<AgentKind, AgentModelConfig>> {
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AGENT_MODELS is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Partial<Record<AgentKind, AgentModelConfig>> = {}
  for (const [kind, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const provider = value.provider
    const model = value.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw new Error(`AGENT_MODELS.${kind} requires string "provider" and "model"`)
    }
    out[kind] = {
      ref: { provider, model },
      temperature: typeof value.temperature === 'number' ? value.temperature : undefined,
      maxOutputTokens:
        typeof value.maxOutputTokens === 'number' ? value.maxOutputTokens : undefined,
      system: typeof value.system === 'string' ? value.system : undefined,
    }
  }
  return out
}

export function loadAgentsConfig(
  env: Env,
  isDirectAvailable: (keyEnv: string) => boolean,
): AgentsConfig {
  // Default unpinned agents/blocks to the Qwen model (its active flavour: direct
  // DashScope when QWEN_API_KEY is set, else the Cloudflare Workers AI variant).
  // An operator can still pin a specific provider/model via the env vars.
  const qwenDefault = resolveModelRef('qwen', isDirectAvailable)
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? qwenDefault?.provider ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? qwenDefault?.model ?? '@cf/qwen/qwen3-30b-a3b-fp8',
    },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.4,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 512,
  }

  return {
    containerImpl: env.CONTAINER_IMPL_ENABLED === 'true',
    routing: {
      default: defaultConfig,
      byKind: parseModelOverrides(env.AGENT_MODELS),
    },
    resolveBlockModel: (modelId) => resolveModelRef(modelId, isDirectAvailable),
  }
}
