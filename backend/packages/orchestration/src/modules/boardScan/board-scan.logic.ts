import type { BlockType, BlueprintModule, BlueprintService } from '@cat-factory/kernel'

// Pure helpers for the board-scan feature — no IO, no ports. They coerce an
// agent's arbitrary JSON into a well-formed blueprint tree (dropping anything
// malformed) and render a node's codebase references into the parseable form the
// board spawn embeds in block descriptions. Keeping them pure makes the scanner
// deterministic and trivially testable without a repo or an LLM.

const BLOCK_TYPES: readonly BlockType[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
]

const MAX_MODULES = 40
const MAX_REFERENCES = 40

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Coerce an arbitrary value into a clean list of repo-relative path references. */
function coerceReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    const path = asString(raw)
    if (path) seen.add(path)
    if (seen.size >= MAX_REFERENCES) break
  }
  return [...seen]
}

function coerceModule(value: unknown): BlueprintModule | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const name = asString(obj.name)
  if (!name) return null
  return {
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
  }
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link BlueprintService},
 * dropping anything malformed. Returns null when no usable service name remains,
 * so the caller can fall back to its deterministic heuristic. `fallbackName` (the
 * repo name) is used when the agent omitted a service name but the tree is sound.
 */
export function coerceService(parsed: unknown, fallbackName: string): BlueprintService | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  // Tolerate either a bare service object or `{ service: {...} }`.
  const root = parsed as Record<string, unknown>
  const obj =
    typeof root.service === 'object' && root.service !== null
      ? (root.service as Record<string, unknown>)
      : root
  const name = asString(obj.name) ?? asString(fallbackName)
  if (!name) return null
  const type = (BLOCK_TYPES as readonly string[]).includes(obj.type as string)
    ? (obj.type as BlockType)
    : 'service'
  const modules = (Array.isArray(obj.modules) ? obj.modules : [])
    .map(coerceModule)
    .filter((m): m is BlueprintModule => m !== null)
    .slice(0, MAX_MODULES)
  return {
    type,
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
    modules,
  }
}

/** Module count for a service — the structural size of the map. */
export function countModules(service: BlueprintService): number {
  return (service.modules ?? []).length
}

/**
 * Render a node's summary and codebase references into a board block description.
 * The references are emitted under a stable `Code references:` marker so an agent
 * scoping later work can parse exactly which files a frame/module/task maps to.
 */
export function describeNode(
  summary: string | undefined,
  references: string[] | undefined,
): string {
  const parts: string[] = []
  const trimmed = summary?.trim()
  if (trimmed) parts.push(trimmed)
  if (references && references.length > 0) {
    parts.push(['Code references:', ...references.map((r) => `- ${r}`)].join('\n'))
  }
  return parts.join('\n\n')
}
