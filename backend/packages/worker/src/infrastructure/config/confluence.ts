import type { Env } from '../env'

export interface ConfluenceConfig {
  /** Opt-in flag; per-workspace site credentials are stored in D1, not here. */
  enabled: boolean
  /** 'llm' uses the agent model to plan structure; 'headings' forces the parser. */
  planner: 'llm' | 'headings'
}

export function loadConfluenceConfig(env: Env): ConfluenceConfig {
  // Opt-in, matching the GitHub-integration default-off convention. The
  // planner defaults to LLM mode; the worker only wires a model provider when a
  // provider credential is present, so absent that the planner still degrades to
  // its deterministic heading parser.
  return {
    enabled: env.CONFLUENCE_ENABLED === 'true',
    planner: env.CONFLUENCE_PLANNER?.trim() === 'headings' ? 'headings' : 'llm',
  }
}
