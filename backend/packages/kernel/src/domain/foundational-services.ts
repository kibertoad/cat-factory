import { parse as parseYaml } from 'yaml'
import type {
  ApiContractFormat,
  ApiContractSummary,
  FoundationalServiceSelection,
} from '@cat-factory/contracts'
import { extractFencedDeclaration } from './fenced-declaration.js'

// ---------------------------------------------------------------------------
// Pure logic for the FOUNDATIONAL SERVICES catalog
// (docs/initiatives/foundational-services.md): recognise a contract document,
// index an OpenAPI document's operations, render the two agent-facing surfaces
// (the cheap catalog the Architect designs against and the lazily-read contract
// bundle its consumers get), and read back the ids the Architect declared.
//
// No I/O and no repository access, so every rule here is unit-testable and both
// runtime facades get identical behaviour by construction.
// ---------------------------------------------------------------------------

/**
 * How many operations of one OpenAPI document ride the CATALOG. The catalog is folded into
 * the Architect's prompt for EVERY registered service, so this is multiplied by the whole
 * catalog size; the cap is what keeps a design dispatch's context proportional to the number
 * of services rather than to the size of their specs. Anything dropped is COUNTED
 * (`omittedOperations`) and stated, never silently truncated.
 */
export const MAX_CATALOG_OPERATIONS = 40

/**
 * How many bytes of ONE contract document ride a consumer's injected context file. A
 * downstream kind reads the documents for only the services the Architect declared, so this
 * bounds a handful of files rather than the catalog — hence far larger than the catalog cap.
 * An over-long document is truncated with an explicit trailing note (see
 * {@link renderContractDocument}), because a silently-cut OpenAPI document reads as a complete
 * API that happens to stop at `/f`.
 */
export const MAX_CONTRACT_BODY_CHARS = 120_000

/** The `.cat-context/` directory the resolved contract documents are injected under. */
export const FOUNDATIONAL_CONTEXT_DIR = 'foundational-services'

/** The index file listing what was injected (and what was asked for but could not be). */
export const FOUNDATIONAL_INDEX_FILE = `${FOUNDATIONAL_CONTEXT_DIR}/index.md`

/**
 * The catalog file a DESIGN-time kind reads. Deliberately the same delivery mechanism as the
 * contract documents (an injected `.cat-context/` file) rather than a new prompt field: it
 * works unchanged for a container dispatch, an inline call and a consensus participant, and
 * the trait guidance can name one stable path instead of three prompt-assembly sites having
 * to agree on a rendering.
 */
export const FOUNDATIONAL_CATALOG_FILE = `${FOUNDATIONAL_CONTEXT_DIR}/catalog.md`

/**
 * The fenced block the Architect writes its declaration in. Parsed back by
 * {@link parseFoundationalDeclaration}; named in the trait guidance so the two cannot drift.
 */
export const FOUNDATIONAL_DECLARATION_TAG = 'foundational-services'

// --- format recognition ---------------------------------------------------

/**
 * Recognise a contract document's format from its PATH and CONTENT.
 *
 * Content leads and the extension only breaks ties: a `.json` file is an OpenAPI document
 * when it declares `openapi: 3.x` and nothing at all otherwise, and a `.ts` module is told
 * apart by which contract library it imports. Returns null when the file is not a contract
 * we can serve — the caller reports that as a SKIPPED file, never as an empty service.
 */
export function detectContractFormat(path: string, content: string): ApiContractFormat | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.js')) {
    if (content.includes('@lokalise/api-contract')) return 'lokalise-api-contract'
    if (content.includes('@toad-contracts/')) return 'toad-contract'
    return null
  }
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.openapi')
  ) {
    return isOpenApiDocument(content) ? 'openapi' : null
  }
  return null
}

/** Whether `content` parses as an OpenAPI **3.x** document (JSON or YAML). */
export function isOpenApiDocument(content: string): boolean {
  const doc = parseOpenApiDocument(content)
  return doc !== null
}

/**
 * Parse an OpenAPI 3.x document from JSON or YAML, or null when it is neither. YAML's parser
 * accepts JSON, so ONE parse covers both; the version check is what makes this a recognition
 * rather than "any object with a paths key" (Swagger 2.0 documents are a different shape and
 * the operation index below would silently produce nothing for one).
 */
function parseOpenApiDocument(content: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch {
    // silent-catch-ok: an unparseable document is simply "not OpenAPI"; the caller reports
    // the file as unrecognised, and the parse error itself names only the file's own syntax.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  const version = doc.openapi
  if (typeof version !== 'string' || !version.startsWith('3.')) return null
  return doc
}

// --- operation indexing ----------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

/**
 * The operations an OpenAPI document declares, as `GET /files/{id}` strings, capped at
 * {@link MAX_CATALOG_OPERATIONS}. Returns `omitted` so the caller can STATE that the list is
 * a prefix — a reader who assumed otherwise would conclude the tail does not exist.
 *
 * A non-OpenAPI document (a TypeScript contract module) indexes to nothing: those are not
 * parsed, and inventing operation names from a regex over source would be a guess presented
 * as a fact.
 */
export function indexOpenApiOperations(content: string): {
  operations: string[]
  omitted: number
} {
  const doc = parseOpenApiDocument(content)
  const paths = doc?.paths
  if (!paths || typeof paths !== 'object') return { operations: [], omitted: 0 }
  const all: string[] = []
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue
    for (const method of HTTP_METHODS) {
      if (method in (item as Record<string, unknown>)) {
        all.push(`${method.toUpperCase()} ${path}`)
      }
    }
  }
  all.sort()
  return {
    operations: all.slice(0, MAX_CATALOG_OPERATIONS),
    omitted: Math.max(0, all.length - MAX_CATALOG_OPERATIONS),
  }
}

/** Build the catalog-facing summary of one stored contract document. */
export function summarizeContract(input: {
  contractId: string
  format: ApiContractFormat
  title: string
  path: string | null
  body: string
}): ApiContractSummary {
  const indexed =
    input.format === 'openapi' ? indexOpenApiOperations(input.body) : { operations: [], omitted: 0 }
  return {
    contractId: input.contractId,
    format: input.format,
    title: input.title,
    size: input.body.length,
    path: input.path,
    operations: indexed.operations,
    omittedOperations: indexed.omitted,
  }
}

// --- the Architect's declaration ------------------------------------------

/**
 * Read the foundational-service ids an agent declared out of its final reply.
 *
 * The contract is a fenced ```foundational-services block holding one id per line (a leading
 * `-` bullet is tolerated, because models write lists). Everything else in the reply is
 * ignored: scanning prose for catalog ids would "find" a service the design merely mentions
 * as a rejected alternative, and the downstream consequence of a false positive is a coder
 * handed the wrong API.
 *
 * The LAST such block wins ({@link extractFencedDeclaration}) — the guidance asks the agent to
 * END its reply with it, and a model that illustrates the shape earlier would otherwise have its
 * example parsed instead of its answer.
 *
 * Ids are matched against `known` so an invented one lands in `unknown` rather than
 * disappearing — see {@link FoundationalServiceSelection}.
 */
export function parseFoundationalDeclaration(
  output: string | undefined,
  known: Iterable<string>,
): FoundationalServiceSelection {
  const empty: FoundationalServiceSelection = { declared: [], unknown: [] }
  const body = extractFencedDeclaration(output, FOUNDATIONAL_DECLARATION_TAG)
  if (body === null) return empty
  const knownIds = new Set(known)
  const declared: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const raw of body.split(/\r?\n/)) {
    const id = raw
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^`|`$/g, '')
      .trim()
      .toLowerCase()
    if (!id || seen.has(id)) continue
    // `none` is the explicit "this design uses no foundational service" answer the guidance
    // asks for. It is a real, distinct outcome from an absent block (the agent never
    // answered), so it must not be recorded as an unknown service id.
    if (id === 'none') continue
    seen.add(id)
    if (knownIds.has(id)) declared.push(id)
    else unknown.push(id)
  }
  return { declared, unknown }
}

// --- agent-facing rendering ------------------------------------------------

/** The catalog projection the Architect designs against — identity, never a document body. */
export interface FoundationalCatalogView {
  id: string
  name: string
  summary: string
  description: string
  capabilities: string[]
  contracts: ApiContractSummary[]
}

/**
 * Render the catalog block folded into a design-time prompt. Deliberately compact: a name, a
 * one-line summary, the capability tags and each contract's format + operation names. The
 * DESCRIPTION is included because "when NOT to use this" is exactly the part a design step
 * needs, and it is the one field an author writes for this purpose.
 *
 * An EMPTY catalog renders as an explicit "none are registered" line rather than nothing —
 * an absent section and an empty one read identically to a model, and the difference is
 * whether "I found no shared service for this" was a finding or an omission.
 */
export function renderFoundationalCatalog(services: FoundationalCatalogView[]): string {
  if (services.length === 0) {
    return 'FOUNDATIONAL SERVICES: none are registered for this workspace. Design the capability yourself, and say so.'
  }
  const lines: string[] = [
    'FOUNDATIONAL SERVICES available to this system (shared capabilities that already exist — prefer consuming one over building your own):',
    '',
  ]
  for (const service of services) {
    lines.push(`- id: ${service.id} — ${service.name}`)
    lines.push(`  ${service.summary}`)
    if (service.capabilities.length > 0) {
      lines.push(`  capabilities: ${service.capabilities.join(', ')}`)
    }
    if (service.description.trim()) {
      lines.push(`  ${service.description.trim().replace(/\r?\n/g, '\n  ')}`)
    }
    for (const contract of service.contracts) {
      const ops =
        contract.operations.length > 0
          ? ` — ${contract.operations.join(', ')}${
              contract.omittedOperations > 0
                ? ` (+${contract.omittedOperations} more operations not listed here)`
                : ''
            }`
          : ''
      lines.push(`  contract (${contract.format}): ${contract.title}${ops}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** One contract document as the lazy read hands it downstream. */
export interface FoundationalContractBundle {
  id: string
  name: string
  summary: string
  description: string
  contracts: { contractId: string; format: ApiContractFormat; title: string; body: string }[]
}

/**
 * Render ONE service's contract documents as the body of its injected context file. Each
 * document is fenced with a language matching its format so the agent reads it as the
 * artifact it is, and an over-long body is cut with an explicit note naming how much was
 * dropped.
 */
export function renderContractDocument(bundle: FoundationalContractBundle): string {
  const lines: string[] = [
    `# ${bundle.name} (\`${bundle.id}\`)`,
    '',
    bundle.summary,
    '',
    bundle.description.trim(),
    '',
  ]
  for (const contract of bundle.contracts) {
    lines.push(`## ${contract.title} (${contract.format})`, '')
    const fence = contract.format === 'openapi' ? 'yaml' : 'ts'
    const { text, omitted } = capBody(contract.body)
    lines.push(`\`\`\`${fence}`, text, '```')
    if (omitted > 0) {
      lines.push(
        '',
        `> This document was truncated: ${omitted} characters of the original ${contract.body.length} are not shown. Treat the remainder as unread rather than absent.`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function capBody(body: string): { text: string; omitted: number } {
  if (body.length <= MAX_CONTRACT_BODY_CHARS) return { text: body, omitted: 0 }
  return {
    text: body.slice(0, MAX_CONTRACT_BODY_CHARS),
    omitted: body.length - MAX_CONTRACT_BODY_CHARS,
  }
}

/**
 * Render the index file that accompanies the injected documents — WHAT was injected, and
 * (the load-bearing half) what the design declared that could NOT be. An id the Architect
 * named but the catalog does not know, and an architect step that never ran at all, are
 * different failures needing different fixes, and neither may render as "no foundational
 * services are involved".
 */
export function renderFoundationalIndex(input: {
  bundles: FoundationalContractBundle[]
  unknown: string[]
  /** True when no design step declared anything (it was skipped, or ran before this feature). */
  noDeclaration: boolean
}): string {
  const lines: string[] = ['# Foundational services for this task', '']
  if (input.noDeclaration) {
    lines.push(
      'No design step declared any foundational service for this task (the design step did not run, or declared none).',
      'Do not infer from this that no shared service applies — nothing was checked. If your work needs a shared capability, say so in your report.',
      '',
    )
  }
  if (input.bundles.length > 0) {
    lines.push(
      'The design declared the services below. Their API contracts are in this directory — treat them as the authoritative interface and do not invent endpoints:',
      '',
    )
    for (const bundle of input.bundles) {
      lines.push(
        `- \`${bundle.id}\` — ${bundle.name}: ${bundle.summary} (see \`${contextFileFor(bundle.id)}\`)`,
      )
    }
    lines.push('')
  } else if (!input.noDeclaration) {
    lines.push('The design declared no foundational services for this task.', '')
  }
  if (input.unknown.length > 0) {
    lines.push(
      `The design also named ${input.unknown.join(', ')}, which the catalog does not contain — no contract is available for ${input.unknown.length === 1 ? 'it' : 'them'}. Do not guess at ${input.unknown.length === 1 ? 'its' : 'their'} API; raise it instead.`,
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

/** The `.cat-context/` path one service's contract bundle is injected at. */
export function contextFileFor(serviceId: string): string {
  return `${FOUNDATIONAL_CONTEXT_DIR}/${serviceId}.md`
}
