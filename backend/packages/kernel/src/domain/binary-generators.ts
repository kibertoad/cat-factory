import type { BinaryModality, BinaryOutputConfig } from '@cat-factory/contracts'
import type { BinaryGeneratorView } from './binary-generator-registry.js'
import { BINARY_OUTPUT_CONTEXT_DIR } from './binary-outputs.js'

// ---------------------------------------------------------------------------
// Pure logic for the GENERATIVE half of a binary-output step: resolving a step's selected
// integrations against the deployment's `BinaryGeneratorRegistry`, refusing a selection that
// cannot do the step's job, and rendering what the agent is told about them.
//
// Deliberately a sibling of `binary-outputs.ts` rather than more of it, because the two halves
// resolve against DIFFERENT registries and their failures need different fixes: an unresolved
// storage id is a workspace-catalog problem (register the service, or fix the step), while an
// unknown generator id is a DEPLOYMENT CODE problem (nobody registered that integration in this
// build). Collapsing them into one refusal would send whoever reads it to the wrong place.
//
// No I/O and no registry access — every rule here is a function of a selection and a list of
// views, so run admission and the dispatch-time brief apply identical rules and both facades get
// identical behaviour by construction.
// ---------------------------------------------------------------------------

/** The `.cat-context/` path one selected integration's contract documents are injected at. */
export function binaryGeneratorContextFileFor(generatorId: string): string {
  return `${BINARY_OUTPUT_CONTEXT_DIR}/generator-${generatorId}.md`
}

/**
 * One selected integration as a DISPATCH sees it — the projection the engine puts on
 * `AgentRunContext`, so the container executor can resolve the credential without needing the
 * registry or the step (it has neither: it rebuilds a dispatch from the context alone).
 *
 * Non-secret by construction, exactly like `ResolvedToolServer`: the credential's KEY NAME is
 * here because the agent must be told which variable to read, and the VALUE travels on the job
 * body's dedicated field, which the agent-context telemetry snapshot omits.
 */
export interface ResolvedBinaryGenerator {
  id: string
  label: string
  modalities: BinaryModality[]
  /** The environment variable the credential is delivered as; absent ⇒ none is declared. */
  credentialKey?: string
  /** Whether a missing credential means the integration must not be called (defaults true). */
  credentialRequired?: boolean
}

/** Project a resolved selection into what the dispatch carries. Unresolved ids contribute
 *  nothing — the BRIEF is where they are stated, because only prose can say what to do about
 *  one, and a half-built entry here would look to the executor like something to authenticate. */
export function dispatchBinaryGenerators(
  selection: ResolvedBinaryGeneratorSelection,
): ResolvedBinaryGenerator[] {
  return selection.selected.map((generator) => ({
    id: generator.id,
    label: generator.name,
    modalities: [...generator.modalities],
    ...(generator.credential ? { credentialKey: generator.credential.key } : {}),
    ...(generator.credential?.required === false ? { credentialRequired: false } : {}),
  }))
}

/** One way a step's generative-integration selection fails against the registry. */
export type BinaryGeneratorSelectionIssue =
  /** A selected id no registered integration answers to. */
  | { problem: 'unknown_generator'; generatorId: string }
  /**
   * A content type the step declares it must deliver that NO selected integration produces.
   * About a requirement rather than an id, which is why it names no generator: the fix is to
   * select one that makes this kind of thing (or to stop claiming the step delivers it).
   */
  | { problem: 'modality_uncovered'; modality: BinaryModality }

/** A step's selection, resolved against the registry's views. */
export interface ResolvedBinaryGeneratorSelection {
  /** The integrations that resolved, in selection order. */
  selected: BinaryGeneratorView[]
  /** Selected ids the registry does not answer to, in selection order. */
  unresolvedIds: string[]
}

/**
 * Resolve a step's `generatorIds` against the registry's views. Pure and shared by admission and
 * the brief, so the two can never disagree about which integrations a step has — the brief runs
 * per dispatch and would otherwise re-derive a set admission already judged.
 */
export function resolveBinaryGeneratorSelection(
  config: BinaryOutputConfig | undefined,
  generators: readonly BinaryGeneratorView[],
): ResolvedBinaryGeneratorSelection {
  const byId = new Map(generators.map((generator) => [generator.id, generator]))
  const selected: BinaryGeneratorView[] = []
  const unresolvedIds: string[] = []
  for (const id of config?.generatorIds ?? []) {
    const generator = byId.get(id)
    if (generator) selected.push(generator)
    else unresolvedIds.push(id)
  }
  return { selected, unresolvedIds }
}

/**
 * Validate a step's generative selection against the RESOLVED registry: every selected id must
 * be registered, and every content type the step declares it delivers must be produced by at
 * least one of them.
 *
 * The coverage rule is the one worth having. A step that must deliver a theme song and selected
 * only an image generator is broken in a way nothing downstream can detect — the agent will
 * generate what it can, store it, and report the rest as an omission at the end of a paid run,
 * which reads as a model failure rather than as the configuration error it is.
 *
 * Returns EVERY issue rather than the first, like its storage-side sibling, so one edit clears a
 * step that lost three integrations instead of three refuse-fix-restart rounds.
 */
export function binaryGeneratorSelectionIssues(
  config: BinaryOutputConfig | undefined,
  generators: readonly BinaryGeneratorView[],
): BinaryGeneratorSelectionIssue[] {
  const { selected, unresolvedIds } = resolveBinaryGeneratorSelection(config, generators)
  const issues: BinaryGeneratorSelectionIssue[] = unresolvedIds.map((generatorId) => ({
    problem: 'unknown_generator' as const,
    generatorId,
  }))
  const covered = new Set(selected.flatMap((generator) => generator.modalities))
  for (const modality of config?.modalities ?? []) {
    if (!covered.has(modality)) issues.push({ problem: 'modality_uncovered', modality })
  }
  return issues
}

/** The content type in words, for a message a human reads. */
export function describeModality(modality: BinaryModality): string {
  switch (modality) {
    case 'image':
      return 'images'
    case 'audio':
      return 'audio (music, speech or sound)'
    case 'video':
      return 'video'
    case '3d':
      return '3D models'
    case 'document':
      return 'documents'
  }
}

/**
 * The operator-facing message for a refused generative selection, naming EVERY issue.
 *
 * Prose, not localized copy: the SPA keys its translated toast off the envelope's
 * `details.reason` / `details.issues` and reveals this text under "Show details" (the standing
 * split — the backend does not localize, and the operator remedy it writes must still be
 * reachable).
 */
export function describeBinaryGeneratorSelectionIssues(
  agentKind: string,
  issues: readonly BinaryGeneratorSelectionIssue[],
): string {
  const clauses = issues.map((issue) =>
    issue.problem === 'unknown_generator'
      ? `'${issue.generatorId}' is not a generative integration this deployment registers`
      : `no selected integration produces ${describeModality(issue.modality)}, which this step declares it delivers`,
  )
  const problems = clauses.length === 1 ? clauses[0] : clauses.map((c) => `\n  - ${c}`).join('')
  return (
    `Step '${agentKind}' generates binary outputs, but its generative selection does not resolve: ${problems}` +
    '\nGenerative integrations are registered in the deployment’s code (BinaryGeneratorRegistry), ' +
    "not in the workspace catalog: register the integration, or fix the step's selection, then start again."
  )
}

/**
 * The brief's GENERATION section: which integrations this step may call, what each produces, how
 * to authenticate, and every gap.
 *
 * Every rule here exists because the alternative is an agent guessing. It names the content types
 * per integration so a step holding both an image and a music generator cannot ask one for the
 * other's output; it names the credential's ENVIRONMENT VARIABLE and says what an unset one means
 * (the platform could not provide it — do not call, report), because the agent is the only party
 * that can see whether the value arrived; and it states an unresolved id rather than dropping it,
 * because a selection that silently shrinks reads as a step nobody configured.
 */
export function renderBinaryGeneratorSection(input: {
  selection: ResolvedBinaryGeneratorSelection
  /** The content types the step declares it must deliver (`stepOptions.binaryOutput.modalities`). */
  requestedModalities: BinaryModality[]
}): string[] {
  const { selected, unresolvedIds } = input.selection
  const lines: string[] = ['## Generation', '']
  if (selected.length === 0 && unresolvedIds.length === 0) {
    return [
      ...lines,
      'No generative integration is configured for this step: generate through the capabilities you already have (your own model, or a tool server you were given). Do not call an outside generation API you were not given credentials for; if the work needs one, report that instead of improvising.',
      '',
    ]
  }
  if (selected.length > 0) {
    lines.push(
      'Generate every artifact through these integrations, and only these. Each is limited to the content types listed — never ask one for a kind of output it does not produce.',
      '',
    )
    for (const generator of selected) {
      lines.push(`### \`${generator.id}\` — ${generator.name}`, '')
      lines.push(`- Produces: ${generator.modalities.map(describeModality).join(', ')}.`)
      if (generator.mediaTypes.length > 0) {
        lines.push(`- Formats: ${generator.mediaTypes.join(', ')}.`)
      } else {
        lines.push(
          '- Formats: not declared — read them off its API contract rather than assuming one.',
        )
      }
      if (generator.endpoint) lines.push(`- Endpoint: ${generator.endpoint}`)
      lines.push(`- ${generator.summary}`)
      if (generator.description.trim()) lines.push('', generator.description.trim())
      if (generator.guidance?.trim()) lines.push('', generator.guidance.trim())
      lines.push('', ...credentialLines(generator), ...contractLines(generator), '')
    }
  }
  if (unresolvedIds.length > 0) {
    lines.push(
      `This step also selects ${unresolvedIds.map((id) => `\`${id}\``).join(', ')}, which this deployment does not register — no endpoint and no contract are available for ${unresolvedIds.length === 1 ? 'it' : 'them'}. Do not guess at ${unresolvedIds.length === 1 ? 'its' : 'their'} API; report the gap and deliver what the remaining integrations can produce.`,
      '',
    )
  }
  const covered = new Set(selected.flatMap((generator) => generator.modalities))
  const uncovered = input.requestedModalities.filter((modality) => !covered.has(modality))
  if (input.requestedModalities.length > 0) {
    lines.push(
      `This step is expected to deliver: ${input.requestedModalities.map(describeModality).join(', ')}.`,
    )
    if (uncovered.length > 0) {
      lines.push(
        `No available integration produces ${uncovered.map(describeModality).join(', ')}. Do not attempt to produce ${uncovered.length === 1 ? 'it' : 'them'} another way — deliver the rest and report this gap by name.`,
      )
    }
    lines.push('')
  }
  return lines
}

/** What the agent is told about an integration's credential — including that it may not be there. */
function credentialLines(generator: BinaryGeneratorView): string[] {
  const credential = generator.credential
  if (!credential) {
    return [
      `No credential is configured for \`${generator.id}\`: call it unauthenticated as its contract describes, and report a rejection rather than inventing a key.`,
    ]
  }
  const usage = credential.usage
    ? ` Send it as ${credential.usage}.`
    : ' Its API contract states how to present it.'
  return [
    `The credential for \`${generator.id}\` is provided to your process as the environment variable \`${credential.key}\`.${usage} Read it from the environment — never echo it, log it, commit it, or put it in your reply.`,
    `If \`${credential.key}\` is unset or empty, the platform could NOT provide the credential: do not call \`${generator.id}\` at all, and report that its credential was unavailable. An empty variable is not an empty key.`,
  ]
}

/** Where an integration's API contract was injected, or the explicit statement that none exists. */
function contractLines(generator: BinaryGeneratorView): string[] {
  if (generator.contracts.length === 0) {
    return [
      `No API contract is registered for \`${generator.id}\`. Its endpoint and the notes above are all the interface you have; do not invent operations or fields, and report what you needed from it instead.`,
    ]
  }
  return [
    `Its API contract is provided at \`.cat-context/${binaryGeneratorContextFileFor(generator.id)}\` — treat it as the authoritative interface and do not invent endpoints or fields.`,
  ]
}
