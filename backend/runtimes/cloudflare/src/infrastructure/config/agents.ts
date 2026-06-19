import type { AgentKind } from '@cat-factory/contracts'
import { resolveModelRef } from '@cat-factory/kernel'
import type { AgentModelConfig } from '@cat-factory/agents'
import type { AgentsConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { num } from './utils'

// The config SHAPE is shared (@cat-factory/server); this module owns the Worker's
// env-driven loader that produces it.
export type { AgentsConfig }

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
    // 5000, not 512: the default model is a *reasoning* model whose `<think>`
    // tokens count against this cap, so a tight limit truncates the answer mid
    // reasoning (finish_reason: length). Operators can still override via env or
    // pin a leaner cap per kind in AGENT_MODELS.
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }

  // The agentic phases — design (bootstrap/architect), build (coder) and review
  // (reviewer) — drive long multi-step tool loops, so they default to GLM-5.2,
  // Cloudflare's agentic-coding model (function calling + 256K context). The
  // small default MoE (qwen3-30b-a3b) is too weak to sustain that loop and tends
  // to spin without committing changes. The cheap default still handles the
  // lighter kinds (e.g. tester, fragment selection, doc planning). An operator's
  // AGENT_MODELS env entry overrides any of these per kind.
  const agenticDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }
  const agenticKinds: AgentKind[] = ['architect', 'coder', 'reviewer']
  const byKind: Partial<Record<AgentKind, AgentModelConfig>> = {}
  for (const kind of agenticKinds) byKind[kind] = agenticDefault
  // Env overrides win over the built-in agentic defaults.
  Object.assign(byKind, parseModelOverrides(env.AGENT_MODELS))

  return {
    routing: {
      default: defaultConfig,
      byKind,
    },
    resolveBlockModel: (modelId) => resolveModelRef(modelId, isDirectAvailable),
  }
}
