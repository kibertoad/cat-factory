import type { DocumentSourceKind } from '@cat-factory/core'
import type { Env } from '../env'

const ALL_SOURCES: readonly DocumentSourceKind[] = ['confluence', 'notion']

export interface DocumentsConfig {
  /** Opt-in flag; per-workspace source credentials are stored in D1, not here. */
  enabled: boolean
  /** Which source providers to register (default: all). */
  sources: DocumentSourceKind[]
  /** 'llm' uses the agent model to plan structure; 'headings' forces the parser. */
  planner: 'llm' | 'headings'
}

/** Parse the comma-separated `DOCUMENT_SOURCES` allow-list, defaulting to all. */
function parseSources(raw: string | undefined): DocumentSourceKind[] {
  if (!raw?.trim()) return [...ALL_SOURCES]
  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const selected = ALL_SOURCES.filter((s) => requested.includes(s))
  return selected.length > 0 ? selected : [...ALL_SOURCES]
}

export function loadDocumentsConfig(env: Env): DocumentsConfig {
  // Opt-in, matching the GitHub-integration default-off convention. The planner
  // defaults to LLM mode; the worker only wires a model provider when a provider
  // credential is present, so absent that the planner still degrades to its
  // deterministic heading parser.
  return {
    enabled: env.DOCUMENTS_ENABLED === 'true',
    sources: parseSources(env.DOCUMENT_SOURCES),
    planner: env.DOCUMENT_PLANNER?.trim() === 'headings' ? 'headings' : 'llm',
  }
}
