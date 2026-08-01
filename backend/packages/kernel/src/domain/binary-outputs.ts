import type {
  BinaryOutputArtifact,
  BinaryOutputConfig,
  BinaryOutputReport,
} from '@cat-factory/contracts'
import type { FoundationalCatalogView } from './foundational-services.js'

// ---------------------------------------------------------------------------
// Pure logic for BINARY-OUTPUT agent steps
// (docs/initiatives/binary-output-foundational-storage.md): a kind that GENERATES binary
// artifacts (image generation is the canonical example) and stores them through a
// FOUNDATIONAL SERVICE its step selected from the workspace catalog, consulting further
// selected services for the SCOPE of the generation (what exists, what lacks an asset, how
// each thing is described).
//
// This module owns the well-known capability tags, the validation of a step's selection
// against the resolved catalog, the rendering of the injected `.cat-context/binary-output/`
// brief, and the read-back of what the agent declared it stored. No I/O and no repository
// access, so every rule is unit-testable and both runtime facades get identical behaviour
// by construction.
// ---------------------------------------------------------------------------

/**
 * The capability tag a foundational service must carry to be selectable as a step's binary
 * STORAGE target. Enforced at run admission: pushing product assets into the org's audit
 * service is a configuration error, not a judgment call left to the agent. (Unrelated to the
 * agents package's `binary-storage` TRAIT, which marks a kind as needing the PLATFORM's own
 * artifact store for run evidence such as screenshots.)
 */
export const BINARY_STORAGE_CAPABILITY = 'binary-storage'

/**
 * The CONVENTIONAL capability tag for a service that can scope a generation — an inventory
 * that answers "what entities exist, which lack an asset, and how is each described". A picker
 * lists services carrying it first, but it is deliberately NOT enforced: any service with a
 * readable contract can inform scope, and refusing one would push the information into prose.
 */
export const GENERATION_CONTEXT_CAPABILITY = 'generation-context'

/** The `.cat-context/` directory the binary-output brief and contract documents live under. */
export const BINARY_OUTPUT_CONTEXT_DIR = 'binary-output'

/**
 * The brief a binary-generating kind starts from: which service to store through, which to
 * consult for scope, and what could NOT be resolved. The trait guidance names this one stable
 * path, and also names its ABSENCE as meaningful (the platform could not provide storage —
 * do not attempt uploads; report instead), so a resolution failure degrades loudly rather
 * than into a prompt pointing at a file that does not exist.
 */
export const BINARY_OUTPUT_BRIEF_FILE = `${BINARY_OUTPUT_CONTEXT_DIR}/brief.md`

/**
 * The fenced block a binary-generating kind ends its reply with, declaring what it stored.
 * Parsed back by {@link parseBinaryOutputDeclaration}; named in the trait guidance so the two
 * cannot drift.
 */
export const BINARY_OUTPUT_DECLARATION_TAG = 'binary-outputs'

/**
 * How many declared artifacts ride ONE step's report. A run that genuinely stores more is a
 * batch job the report only needs to EVIDENCE, not enumerate; everything past the cap is
 * counted in `omitted` rather than silently shortened.
 */
export const MAX_BINARY_OUTPUT_ENTRIES = 100

/** Longest `service`/`location` accepted per entry — beyond it the entry is INVALID (a
 *  truncated storage location is corrupt, not shortened). */
const MAX_IDENTITY_CHARS = 512

/** Longest optional display field retained per entry; the excess is elided with a marker. */
const MAX_DISPLAY_CHARS = 500

/** The `.cat-context/` path one selected service's contract documents are injected at. */
export function binaryContextFileFor(serviceId: string): string {
  return `${BINARY_OUTPUT_CONTEXT_DIR}/${serviceId}.md`
}

// --- selection validation ---------------------------------------------------

/** One way a step's selection fails to resolve against the catalog. */
export interface BinaryOutputConfigIssue {
  /** Which half of the selection the offending id sits in. */
  role: 'storage' | 'context'
  serviceId: string
  problem: 'unknown_service' | 'not_storage_capable'
}

/**
 * Validate a step's selection against the RESOLVED catalog. Pure, so run admission and any
 * future save-time surface apply identical rules: the storage id must exist AND carry
 * {@link BINARY_STORAGE_CAPABILITY}; each context id must exist. Returns every issue rather
 * than the first, so a refusal can name the whole fix.
 */
export function binaryOutputConfigIssues(
  config: BinaryOutputConfig,
  catalog: readonly Pick<FoundationalCatalogView, 'id' | 'capabilities'>[],
): BinaryOutputConfigIssue[] {
  const byId = new Map(catalog.map((service) => [service.id, service]))
  const issues: BinaryOutputConfigIssue[] = []
  const storage = byId.get(config.storageServiceId)
  if (!storage) {
    issues.push({
      role: 'storage',
      serviceId: config.storageServiceId,
      problem: 'unknown_service',
    })
  } else if (!storage.capabilities.includes(BINARY_STORAGE_CAPABILITY)) {
    issues.push({
      role: 'storage',
      serviceId: config.storageServiceId,
      problem: 'not_storage_capable',
    })
  }
  for (const id of config.contextServiceIds ?? []) {
    if (!byId.has(id)) issues.push({ role: 'context', serviceId: id, problem: 'unknown_service' })
  }
  return issues
}

// --- the agent's declaration ------------------------------------------------

/**
 * Read what a binary-generating agent declared it stored out of its final reply.
 *
 * The contract is a fenced ```binary-outputs block holding either the literal `none` or a JSON
 * array of `{ service, location, entity?, contentType?, description? }` entries (a single bare
 * object is tolerated, because models write one when they stored one). Everything else in the
 * reply is ignored — scanning prose would "find" an artifact the agent merely planned.
 *
 * Every loss is bookkept rather than silently absorbed: a missing block is `undeclared`, an
 * unparseable body is `parseFailed`, malformed entries are counted in `invalidEntries`, valid
 * entries past {@link MAX_BINARY_OUTPUT_ENTRIES} in `omitted`, and a `service` id not in
 * `known` is listed in `unknownServices` while its entries are KEPT — the platform records the
 * claim; a reader judges it against the step's configured target.
 */
export function parseBinaryOutputDeclaration(
  output: string | undefined,
  known: Iterable<string>,
): BinaryOutputReport {
  const empty: BinaryOutputReport = {
    stored: [],
    unknownServices: [],
    invalidEntries: 0,
    omitted: 0,
  }
  if (!output) return { ...empty, undeclared: true }
  const fence = new RegExp(
    `\`\`\`${BINARY_OUTPUT_DECLARATION_TAG}\\s*\\r?\\n([\\s\\S]*?)\`\`\``,
    'i',
  )
  const match = output.match(fence)
  if (!match) return { ...empty, undeclared: true }
  const body = (match[1] ?? '').trim()
  if (body.toLowerCase() === 'none') return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // silent-catch-ok: an unparseable body is a REPORTED state (`parseFailed`), not an error —
    // the step already succeeded and the parse error names only the reply's own syntax.
    return { ...empty, parseFailed: true }
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]

  const knownIds = new Set(known)
  const stored: BinaryOutputArtifact[] = []
  const unknownServices: string[] = []
  let invalidEntries = 0
  let omitted = 0
  for (const entry of entries) {
    const artifact = coerceArtifact(entry)
    if (!artifact) {
      invalidEntries++
      continue
    }
    if (stored.length >= MAX_BINARY_OUTPUT_ENTRIES) {
      omitted++
      continue
    }
    stored.push(artifact)
    if (!knownIds.has(artifact.service) && !unknownServices.includes(artifact.service)) {
      unknownServices.push(artifact.service)
    }
  }
  return { stored, unknownServices, invalidEntries, omitted }
}

function coerceArtifact(entry: unknown): BinaryOutputArtifact | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const service = identityField(record.service)?.toLowerCase()
  const location = identityField(record.location)
  if (!service || !location) return null
  const artifact: BinaryOutputArtifact = { service, location }
  const entity = displayField(record.entity)
  const contentType = displayField(record.contentType)
  const description = displayField(record.description)
  if (entity) artifact.entity = entity
  if (contentType) artifact.contentType = contentType
  if (description) artifact.description = description
  return artifact
}

/** A field that IDENTIFIES something: required to be a non-empty string within the cap —
 *  truncating it would corrupt it, so an over-long one invalidates the entry instead. */
function identityField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_IDENTITY_CHARS) return null
  return trimmed
}

/** A field that DESCRIBES something: kept best-effort, elided past the cap with a marker. */
function displayField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_DISPLAY_CHARS ? `${trimmed.slice(0, MAX_DISPLAY_CHARS)}…` : trimmed
}

// --- agent-facing rendering -------------------------------------------------

/** The resolved half of a step's selection, as the brief renderer receives it. */
export interface BinaryOutputBriefInput {
  /** The step's selection, or undefined when the step carries none (the brief then says so). */
  config: BinaryOutputConfig | undefined
  /** The resolved storage service, or null when `config.storageServiceId` is not in the catalog. */
  storage: FoundationalCatalogView | null
  /** The resolved context services, in selection order. */
  contextServices: FoundationalCatalogView[]
  /** Selected context ids the catalog could not resolve. */
  unresolvedContextIds: string[]
}

/**
 * Render `.cat-context/binary-output/brief.md` — the ONE file a binary-generating agent starts
 * from. It names the storage target and the scope services concretely (the trait guidance owns
 * the generic workflow and the declaration shape), and it STATES every gap instead of omitting
 * it: an unresolved storage id, a service with no registered contract, a context id the catalog
 * does not know. A generator told nothing would guess, and a guessed storage endpoint is how an
 * asset lands somewhere nobody can find it.
 */
export function renderBinaryOutputBrief(input: BinaryOutputBriefInput): string {
  const lines: string[] = ['# Binary outputs for this step', '']
  if (!input.config) {
    lines.push(
      'No storage service is selected for this step. Do NOT attempt to store or upload any generated binary — generate nothing you cannot deliver, and state in your report that no storage service was configured.',
    )
    return lines.join('\n').trimEnd()
  }
  if (!input.storage) {
    lines.push(
      `This step is configured to store its binary outputs through the foundational service \`${input.config.storageServiceId}\`, but the workspace catalog does not contain it. Do NOT store the outputs anywhere else and do not guess at its API — state in your report that the storage service could not be resolved.`,
      '',
    )
  } else {
    lines.push(
      `Store EVERY binary you generate through \`${input.storage.id}\` — ${input.storage.name}: ${input.storage.summary}`,
      '',
    )
    if (!input.storage.capabilities.includes(BINARY_STORAGE_CAPABILITY)) {
      lines.push(
        `Note: \`${input.storage.id}\` does not advertise the \`${BINARY_STORAGE_CAPABILITY}\` capability. It was still selected for this step; if its API offers no way to store binary content, say so in your report rather than improvising.`,
        '',
      )
    }
    lines.push(...contractPointer(input.storage), '')
  }
  if (input.contextServices.length > 0 || input.unresolvedContextIds.length > 0) {
    lines.push(
      'Consult these services to decide the SCOPE of the generation — what exists, what already has an asset, what each thing is — before generating anything:',
      '',
    )
    for (const service of input.contextServices) {
      lines.push(`- \`${service.id}\` — ${service.name}: ${service.summary}`)
      lines.push(`  ${contractPointer(service).join(' ')}`)
    }
    if (input.unresolvedContextIds.length > 0) {
      lines.push(
        `- The selection also named ${input.unresolvedContextIds.map((id) => `\`${id}\``).join(', ')}, which the catalog does not contain — no contract is available. Do not guess at ${input.unresolvedContextIds.length === 1 ? 'its' : 'their'} API; note the gap in your report.`,
      )
    }
    lines.push('')
  } else {
    lines.push(
      'No context service is selected: the task description and the other provided context are the whole scope of the generation.',
      '',
    )
  }
  lines.push(
    `Declare what you stored in the fenced \`\`\`${BINARY_OUTPUT_DECLARATION_TAG} block your guidance describes, naming each artifact's service id and its location exactly as the storage service reported it.`,
  )
  return lines.join('\n').trimEnd()
}

/** Where a service's API contract was injected, or the explicit statement that none exists. */
function contractPointer(service: FoundationalCatalogView): string[] {
  if (service.contracts.length === 0) {
    return [
      `No API contract is registered for \`${service.id}\`. Do not invent its endpoints; report what you needed from it instead.`,
    ]
  }
  return [
    `Its API contract is provided at \`.cat-context/${binaryContextFileFor(service.id)}\` — treat it as the authoritative interface and do not invent endpoints or fields.`,
  ]
}
