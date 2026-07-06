import type { AgentKind } from '@cat-factory/contracts'
import { type ProviderCapabilities, resolveModelRef } from '@cat-factory/kernel'
import type { AgentModelConfig } from '@cat-factory/agents'
import { ENV_HELP, type AgentsConfig, configProblem } from '@cat-factory/server'
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
    throw configProblem({
      key: 'AGENT_MODELS',
      summary: ENV_HELP.AGENT_MODELS.summary,
      remedy: `It is not valid JSON. ${ENV_HELP.AGENT_MODELS.remedy}`,
    })
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Partial<Record<AgentKind, AgentModelConfig>> = {}
  for (const [kind, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const provider = value.provider
    const model = value.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw configProblem({
        key: 'AGENT_MODELS',
        summary: ENV_HELP.AGENT_MODELS.summary,
        remedy: `Entry "${kind}" is missing a string "provider" and/or "model". ${ENV_HELP.AGENT_MODELS.remedy}`,
      })
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

export function loadAgentsConfig(env: Env, caps: ProviderCapabilities): AgentsConfig {
  // Default unpinned agents/blocks to the Qwen model (its active flavour: the
  // Cloudflare Workers AI variant when the Cloudflare lib is enabled, upgraded to
  // direct DashScope per-workspace by the executor when a Qwen key is configured).
  // An operator can still pin a specific provider/model via the env vars.
  const qwenDefault = resolveModelRef('qwen', caps)
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
  // (reviewer) — drive long multi-step tool loops, so they default to a strong
  // agentic-coding model rather than the small default MoE (qwen3-30b-a3b), which
  // is too weak to sustain that loop and tends to spin without committing changes.
  // The cheap default still handles the lighter kinds (e.g. tester, fragment
  // selection, doc planning). An operator's AGENT_MODELS env entry overrides any
  // of these per kind.
  const agenticDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }
  // The coder (implementer) runs the longest, most tool-heavy loop, where GLM-5.2
  // on Workers AI was observed emitting malformed tool calls (e.g. `write` with no
  // `path`) and looping until the harness no-progress guard aborted. Kimi K2.7 (a
  // 1T-param model with structured outputs for agentic workloads, native on Workers
  // AI) holds up better on that sustained tool loop, so the build phase defaults to
  // it while design/review stay on GLM-5.2.
  const coderDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.7-code' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }
  // Companions (reviewer / spec-companion / architect-companion) return their whole
  // verdict — rating + summary + per-item comments — as ONE inline JSON reply. On a
  // reasoning model the <think> tokens share the output budget, so the 5000 cap can
  // truncate the JSON mid-comment, leaving it unparseable (the run then can't read the
  // review). Give companions a larger budget so the verdict fits. Strong agentic model,
  // like the reviewer was already on.
  const companionDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 12000,
  }
  // The conflict-resolver clones a PR head with merge conflicts and rewrites the
  // conflicted hunks against the base — a focused, diff-heavy reasoning task over
  // potentially large files. Kimi K2.5 (a 1T-param agentic model native on Workers AI,
  // 256K window) handles that better than the small default MoE.
  const conflictResolverDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.5' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }
  const byKind: Partial<Record<AgentKind, AgentModelConfig>> = {
    architect: agenticDefault,
    reviewer: companionDefault,
    'spec-companion': companionDefault,
    'architect-companion': companionDefault,
    coder: coderDefault,
    'conflict-resolver': conflictResolverDefault,
  }
  // Env overrides win over the built-in agentic defaults.
  Object.assign(byKind, parseModelOverrides(env.AGENT_MODELS))

  return {
    routing: {
      default: defaultConfig,
      byKind,
    },
    resolveBlockModel: (modelId) => resolveModelRef(modelId, caps),
  }
}
