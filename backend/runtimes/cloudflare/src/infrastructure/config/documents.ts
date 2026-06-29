import type { DocumentSourceKind } from '@cat-factory/kernel'
import type { DocumentsConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { DocumentsConfig }

// Every source this facade knows how to wire — the validation set an explicit
// `DOCUMENT_SOURCES` entry is checked against.
const ALL_SOURCES: readonly DocumentSourceKind[] = [
  'confluence',
  'notion',
  'github',
  'figma',
  'zeplin',
  'linear',
]

// Sources enabled when `DOCUMENT_SOURCES` is unset. Every known source is on by default;
// each is a no-op until a tenant connects it interactively in the UI.
const DEFAULT_SOURCES: readonly DocumentSourceKind[] = [...ALL_SOURCES]

/** Parse the comma-separated `DOCUMENT_SOURCES` allow-list, defaulting to the on-by-default set. */
function parseSources(raw: string | undefined): DocumentSourceKind[] {
  if (!raw?.trim()) return [...DEFAULT_SOURCES]
  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const selected = ALL_SOURCES.filter((s) => requested.includes(s))
  return selected.length > 0 ? selected : [...DEFAULT_SOURCES]
}

export function loadDocumentsConfig(env: Env): DocumentsConfig {
  // The document-source integration (Notion/Confluence/GitHub docs) is always on:
  // tenants connect their own sources interactively through the UI, so there is no
  // service-level enable flag to forget. The one hard requirement is a master key
  // for encrypting those per-workspace credentials at rest — without it we would be
  // persisting tokens in plaintext, so we fail loudly at config load rather than
  // silently disabling the feature (which is how it used to vanish from the UI).
  // The planner defaults to LLM mode; the worker only wires a model provider when a
  // provider credential is present, so absent that the planner still degrades to its
  // deterministic heading parser.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY is required: the document-source integration (Notion, Confluence, …) ' +
        'encrypts per-workspace source credentials at rest. Set it to a base64-encoded key of ' +
        'at least 32 bytes.',
    )
  }
  return {
    enabled: true,
    sources: parseSources(env.DOCUMENT_SOURCES),
    planner: env.DOCUMENT_PLANNER?.trim() === 'headings' ? 'headings' : 'llm',
    encryptionKey,
  }
}
