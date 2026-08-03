import type {
  BinaryModality,
  BinaryOutputArtifact,
  BinaryOutputConfig,
  BinaryOutputReport,
} from '@cat-factory/contracts'
import {
  ASSET_STORAGE_CAPABILITY,
  GENERATION_CONTEXT_CAPABILITY,
  modalityOfMediaType,
} from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_BRIEF_FILE,
  BINARY_OUTPUT_CONTEXT_DIR,
  binaryContextFileFor,
} from './binary-output-paths.js'
import { extractFencedDeclaration } from './fenced-declaration.js'
import type { FoundationalCatalogView } from './foundational-services.js'
import {
  type ResolvedBinaryGeneratorSelection,
  renderBinaryGeneratorSection,
} from './binary-generators.js'

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
 * The well-known capability tags, re-exported from the WIRE vocabulary that defines them
 * (`@cat-factory/contracts`). They moved there because the people who must spell them exactly
 * are outside the backend — a deployment registering its estate, the SPA rendering a picker —
 * and a client that cannot import a tag re-declares it, where a re-declaration's failure is
 * silent (`asset_storage` registers cleanly and surfaces much later as a refused run). The
 * catalog write boundary now refuses a near-miss of either one.
 *
 * `ASSET_STORAGE_CAPABILITY` is deliberately NOT spelled `binary-storage`, which is the agents
 * package's `BINARY_STORAGE_TRAIT` — a marker on a KIND that needs the PLATFORM's own artifact
 * store for run EVIDENCE (the UI Tester's screenshots). The two mean opposite things about
 * opposite subjects, and while they shared one literal, `RunAdmission` imported both, a swap
 * typechecked, and no test could tell. `binary-outputs.spec.ts` in `@cat-factory/agents` — the
 * one package that can see both — pins them apart.
 */
export { ASSET_STORAGE_CAPABILITY, GENERATION_CONTEXT_CAPABILITY }

// The `.cat-context/` path vocabulary lives in the LEAF `binary-output-paths.ts`, which this file
// and `binary-generators.ts` both import — they import each OTHER, so a constant derived across
// that cycle throws at module init in the assembled backend while every unit test passes.
// Re-exported so every consumer keeps importing these names from where they always did.
export { BINARY_OUTPUT_BRIEF_FILE, BINARY_OUTPUT_CONTEXT_DIR, binaryContextFileFor }

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
 * {@link ASSET_STORAGE_CAPABILITY}; each context id must exist. Returns every issue rather
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
  } else if (!storage.capabilities.includes(ASSET_STORAGE_CAPABILITY)) {
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

/**
 * The operator-facing message for a refused selection, naming EVERY issue
 * {@link binaryOutputConfigIssues} found rather than only the one that happens to sort first.
 *
 * That completeness is the whole point of collecting them: a step selecting three context ids
 * the catalog lost would otherwise be fixed, restarted, and refused again — once per id — with
 * each round costing a full admission cycle. The refusal names the whole fix so one edit clears
 * it.
 *
 * Prose, not localized copy: the SPA keys its translated toast off the envelope's
 * `details.reason` / `details.issues` and reveals this text under "Show details" (the standing
 * split — the backend does not localize, and its operator remedies must still be reachable).
 */
export function describeBinaryOutputConfigIssues(
  agentKind: string,
  issues: readonly BinaryOutputConfigIssue[],
): string {
  const clauses = issues.map((issue) => {
    if (issue.problem === 'not_storage_capable') {
      return `'${issue.serviceId}' is registered but does not declare the '${ASSET_STORAGE_CAPABILITY}' capability, so it cannot be the storage target`
    }
    const role = issue.role === 'storage' ? 'storage target' : 'generation context'
    return `'${issue.serviceId}' (selected as ${role}) is not in the workspace's catalog`
  })
  const problems = clauses.length === 1 ? clauses[0] : clauses.map((c) => `\n  - ${c}`).join('')
  return (
    `Step '${agentKind}' generates binary outputs, but its selection does not resolve: ${problems}` +
    "\nFix the step's selection, register the missing service, or add the " +
    `'${ASSET_STORAGE_CAPABILITY}' capability to the one you meant, then start again.`
  )
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
 *
 * The LAST block wins ({@link extractFencedDeclaration}), because the guidance asks the agent to
 * END its reply with it and models routinely illustrate the shape first.
 */
export function parseBinaryOutputDeclaration(
  output: string | undefined,
  known: {
    /** Ids in the workspace's resolved foundational catalog (the storage/context half). */
    services: Iterable<string>
    /**
     * Ids the deployment registers on its `BinaryGeneratorRegistry` (the generative half).
     * Absent/empty is a real answer — a deployment that registers none — so every claimed id is
     * then reported as unknown. For "could not be read at all", pass {@link generatorsUnverified}
     * instead; the two must never be spelled the same way.
     */
    generators?: Iterable<string>
    /**
     * Set when the generative set could not be READ, so no claimed id may be judged against it.
     * `unknownGenerators` is then left EMPTY and the report says `generatorsUnverified` — the
     * platform states what it could not check rather than filing it as an invention. The storage
     * half is still judged: it resolves against the workspace catalog, which this says nothing
     * about, and dropping a verdict that WAS computable is the other half of the same mistake.
     */
    generatorsUnverified?: boolean
  },
): BinaryOutputReport {
  // The unverified flag rides EVERY return below, the early ones included: "nobody could check
  // the integrations" is true of an undeclared or unparseable reply exactly as it is of a parsed
  // one, and a reader comparing two settlements must not see the fact appear and disappear with
  // the shape of the agent's reply.
  const empty: BinaryOutputReport = {
    stored: [],
    unknownServices: [],
    unknownGenerators: [],
    ...(known.generatorsUnverified ? { generatorsUnverified: true as const } : {}),
    invalidEntries: 0,
    omitted: 0,
  }
  const body = extractFencedDeclaration(output, BINARY_OUTPUT_DECLARATION_TAG)
  if (body === null) return { ...empty, undeclared: true }
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

  const knownServices = new Set(known.services)
  const knownGenerators = new Set(known.generators ?? [])
  const stored: BinaryOutputArtifact[] = []
  const unknownServices: string[] = []
  const unknownGenerators: string[] = []
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
    if (!knownServices.has(artifact.service) && !unknownServices.includes(artifact.service)) {
      unknownServices.push(artifact.service)
    }
    const generator = artifact.generator
    // Skipped entirely when the set could not be read: with nothing to compare against, every
    // claimed id would land in `unknownGenerators` and read as an agent naming integrations that
    // do not exist — a fabricated accusation, on the surface a human reviews to decide whether
    // the run's artifacts are real.
    if (
      generator &&
      !known.generatorsUnverified &&
      !knownGenerators.has(generator) &&
      !unknownGenerators.includes(generator)
    ) {
      unknownGenerators.push(generator)
    }
  }
  return {
    stored,
    unknownServices,
    unknownGenerators,
    ...(known.generatorsUnverified ? { generatorsUnverified: true as const } : {}),
    invalidEntries,
    omitted,
  }
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
  // Lowercased like `service`, and for the same reason: registry ids are lower-kebab slugs, so a
  // model that capitalises one means the registered integration and must not be reported unknown.
  const generator = identityField(record.generator)?.toLowerCase()
  if (entity) artifact.entity = entity
  if (contentType) artifact.contentType = contentType
  if (description) artifact.description = description
  if (generator) artifact.generator = generator
  // The platform CLASSIFIES; the model only reports. An unrecognised media type leaves `modality`
  // ABSENT rather than guessing one — "we cannot tell what this is" is not "this is not an image".
  const modality: BinaryModality | null = contentType ? modalityOfMediaType(contentType) : null
  if (modality) artifact.modality = modality
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

/**
 * A field that DESCRIBES something: kept best-effort, elided past the cap with a marker. The
 * retained text is a PLAIN PREFIX and the `…` says so, which is what the cap owes a reader —
 * unlike the entry-level caps beside it, where what was dropped is a countable thing and is
 * therefore counted (`omitted` / `invalidEntries`).
 */
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
  /**
   * The step's GENERATIVE integrations, resolved against the deployment registry. Absent ⇒ the
   * renderer treats it as an empty selection, which is rendered as its own stated case ("no
   * generative integration is configured") rather than as silence.
   */
  generators?: ResolvedBinaryGeneratorSelection
}

/**
 * Render `.cat-context/binary-output/brief.md` — the ONE file a binary-generating agent starts
 * from. Three sections in the order the work happens: what MAKES the artifacts (the step's
 * generative integrations, their content types and credentials), what to make (the scope
 * services), and where it GOES (the storage service). The trait guidance owns the generic
 * workflow and the declaration shape; this file is the concrete half.
 *
 * It STATES every gap instead of omitting it: an unresolved storage id, a service or integration
 * with no registered contract, a context id the catalog does not know, a content type the step
 * must deliver that nothing selected can produce. A generator told nothing would guess, and a
 * guessed endpoint is how an asset lands somewhere nobody can find it — or is never made at all.
 */
export function renderBinaryOutputBrief(input: BinaryOutputBriefInput): string {
  const lines: string[] = ['# Binary outputs for this step', '']
  if (!input.config) {
    lines.push(
      'No storage service is selected for this step. Do NOT attempt to store or upload any generated binary — generate nothing you cannot deliver, and state in your report that no storage service was configured.',
    )
    return lines.join('\n').trimEnd()
  }
  // Generation first, then scope, then storage: the order of the work. A generator that reads
  // only the top of this file must still learn WHAT MAKES the artifacts before anything else,
  // because that is the decision it cannot recover from later.
  lines.push(
    ...renderBinaryGeneratorSection({
      selection: input.generators ?? { selected: [], unresolvedIds: [] },
      requestedModalities: input.config.modalities ?? [],
    }),
  )
  lines.push(...renderScopeSection(input), ...renderStorageSection(input))
  lines.push(
    `Declare what you stored in the fenced \`\`\`${BINARY_OUTPUT_DECLARATION_TAG} block your guidance describes, naming each artifact's service id, the integration that generated it, and its location exactly as the storage service reported it.`,
  )
  return lines.join('\n').trimEnd()
}

/** The SCOPE half: which catalog services say what to generate, and which could not be resolved. */
function renderScopeSection(input: BinaryOutputBriefInput): string[] {
  const lines: string[] = ['## Scope', '']
  if (input.contextServices.length === 0 && input.unresolvedContextIds.length === 0) {
    return [
      ...lines,
      'No context service is selected: the task description and the other provided context are the whole scope of the generation.',
      '',
    ]
  }
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
  return lines
}

/** The STORAGE half: the one service every artifact goes through, or why there is none. */
function renderStorageSection(input: BinaryOutputBriefInput): string[] {
  const lines: string[] = ['## Storage', '']
  if (!input.storage) {
    lines.push(
      `This step is configured to store its binary outputs through the foundational service \`${input.config?.storageServiceId}\`, but the workspace catalog does not contain it. Do NOT store the outputs anywhere else and do not guess at its API — state in your report that the storage service could not be resolved.`,
      '',
    )
    return lines
  }
  lines.push(
    `Store EVERY binary you generate through \`${input.storage.id}\` — ${input.storage.name}: ${input.storage.summary}`,
    '',
  )
  if (!input.storage.capabilities.includes(ASSET_STORAGE_CAPABILITY)) {
    lines.push(
      `Note: \`${input.storage.id}\` does not advertise the \`${ASSET_STORAGE_CAPABILITY}\` capability. It was still selected for this step; if its API offers no way to store binary content, say so in your report rather than improvising.`,
      '',
    )
  }
  lines.push(...contractPointer(input.storage), '')
  return lines
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
