import type { AgentKind } from '@cat-factory/contracts'
import type { AgentModelConfig, AgentRouting } from '@cat-factory/core'
import type { Env } from './env'

// Translates the flat, string-typed Worker environment into a structured app
// config — in particular the agent model routing ("which LLM, with what config,
// for what"). Operators tune behaviour entirely through wrangler vars / secrets.

export type ExecutionMode = 'workflow' | 'tick'

export interface AppConfig {
  agents: {
    enabled: boolean
    routing: AgentRouting
  }
  execution: {
    /** 'workflow' drives runs durably; 'tick' keeps the legacy polling engine. */
    mode: ExecutionMode
    /** Human-decision park timeout passed to the workflow's waitForEvent. */
    decisionTimeout: string
  }
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
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

export function loadConfig(env: Env): AppConfig {
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
    },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.4,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 512,
  }

  return {
    agents: {
      enabled: env.AGENTS_ENABLED === 'true',
      routing: {
        default: defaultConfig,
        byKind: parseModelOverrides(env.AGENT_MODELS),
      },
    },
    execution: {
      // Default to 'tick' so behaviour is unchanged until an operator opts in,
      // mirroring the AGENTS_ENABLED default-off convention.
      mode: env.EXECUTION_MODE === 'workflow' ? 'workflow' : 'tick',
      decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    },
  }
}
