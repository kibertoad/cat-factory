import type { BinaryModality, BinaryOutputConfig } from '@cat-factory/contracts'
import type { BinaryGeneratorView } from './binary-generator-registry.js'
import {
  BINARY_GENERATOR_CONTEXT_DIR,
  binaryGeneratorContextFileFor,
} from './binary-output-paths.js'

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

// The `.cat-context/` path vocabulary lives in a LEAF module (`binary-output-paths.ts`) that this
// file and its `binary-outputs.ts` sibling both import: the two import each other, so a constant
// derived across that cycle is a module-init TDZ crash in the assembled backend. Re-exported here
// so every consumer keeps importing the name from where it always did.
export { BINARY_GENERATOR_CONTEXT_DIR, binaryGeneratorContextFileFor }

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
  /**
   * A concrete FORMAT the step declares it must deliver that no selected integration says it can
   * emit. One notch finer than the modality above and refused for the same reason: a mesh in a
   * container the consuming engine cannot import is not a thinner deliverable, it is an unusable
   * one, and nothing downstream can tell the difference.
   *
   * Only ever raised against integrations that DECLARED their formats — see
   * {@link binaryFormatCoverage} for the third state, which is not an issue.
   */
  | { problem: 'media_type_uncovered'; mediaType: string }

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
 * How a step's declared FORMATS stand against what its selected integrations say they emit.
 *
 * THREE outcomes, not two, and the third is the whole reason this is its own function. A
 * generator declaring no `mediaTypes` is an explicit, documented state — "only the coarse
 * modality is known" — so a requirement it cannot be judged against is UNVERIFIABLE, not
 * uncovered. Refusing there would punish the honest declaration and break every integration that
 * has not pinned its formats down; calling it covered would be the mirror mistake, a clean bill
 * of health nobody issued, on the surface that decides whether the run may start. So the run is
 * admitted and the gap is STATED — to the agent in its brief, and to whoever composes the step —
 * which is the same disposition `generatorsUnverified` takes on the settlement side.
 *
 * Pure and shared by admission, the brief and the SPA's mirror, so none of them can hold a
 * different opinion about the same selection.
 */
export interface BinaryFormatCoverage {
  /** Declared formats no selected integration emits, judged against integrations that DECLARED
   *  theirs. These refuse the run. */
  uncovered: string[]
  /** Declared formats nothing selected claims, where at least one selected integration declares
   *  no formats at all — so the requirement MIGHT be met and nothing here may say otherwise. */
  unverifiable: string[]
}

export function binaryFormatCoverage(
  required: readonly string[],
  selected: readonly Pick<BinaryGeneratorView, 'mediaTypes'>[],
): BinaryFormatCoverage {
  const emitted = new Set(selected.flatMap((generator) => generator.mediaTypes))
  // An EMPTY selection declares nothing and hides nothing: with no integration to be silent, a
  // format requirement is uncovered outright, exactly as a modality requirement already is.
  const undeclared = selected.some((generator) => generator.mediaTypes.length === 0)
  const uncovered: string[] = []
  const unverifiable: string[] = []
  for (const mediaType of required) {
    if (emitted.has(mediaType)) continue
    if (undeclared) unverifiable.push(mediaType)
    else uncovered.push(mediaType)
  }
  return { uncovered, unverifiable }
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
  // Only the UNCOVERED half refuses. An unverifiable format is reported to the agent by the brief
  // and to the composer by the picker, and admitting it is the point: see `binaryFormatCoverage`.
  for (const mediaType of binaryFormatCoverage(config?.mediaTypes ?? [], selected).uncovered) {
    issues.push({ problem: 'media_type_uncovered', mediaType })
  }
  return issues
}

/**
 * The content type in words, for a message a human reads.
 *
 * The `default` is not dead code, and it is not a widened type either. `BinaryModality` is a
 * CLOSED vocabulary that is nonetheless PERSISTED on a step, so a member retired from the union
 * goes on existing in saved pipelines: `3d` did exactly that when it split. Such a value reaches
 * here through the modality-uncovered refusal it is guaranteed to raise — which is to say the one
 * message whose whole job is to name what a human must re-pick — so falling off the end of the
 * switch would render it `undefined` and turn the loud break into a nonsense sentence.
 *
 * {@link describeRetiredModality} takes `never`, so this keeps BOTH properties at once: adding a
 * member without a case still fails the typecheck (the argument is no longer `never`), while a
 * value the union never had is still described honestly at runtime.
 */
export function describeModality(modality: BinaryModality): string {
  switch (modality) {
    case 'image':
      return 'images'
    case 'audio':
      return 'audio (music, speech or sound)'
    case 'video':
      return 'video'
    case '3d-model':
      return '3D models (one asset each)'
    case '3d-scene':
      return '3D scenes (several assets composed together)'
    case 'document':
      return 'documents'
    default:
      return describeRetiredModality(modality)
  }
}

/**
 * A stored content type this build no longer defines, named as the retired value it is.
 *
 * Deliberately NOT mapped onto a current member — nothing here knows which one was meant, and
 * that unknowability is the whole reason a split retires the old name rather than aliasing it.
 * Saying so is the honest answer and the actionable one: it sends the reader to re-pick the step
 * rather than to a selection with nothing wrong with it.
 */
function describeRetiredModality(modality: never): string {
  return `'${String(modality)}' (a content type this deployment no longer defines — the step must be re-picked)`
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
  const clauses = issues.map((issue) => {
    if (issue.problem === 'unknown_generator') {
      return `'${issue.generatorId}' is not a generative integration this deployment registers`
    }
    if (issue.problem === 'media_type_uncovered') {
      return `no selected integration emits '${issue.mediaType}', which this step declares it delivers — the integrations it selects declare the formats they emit, and this is not one of them`
    }
    return `no selected integration produces ${describeModality(issue.modality)}, which this step declares it delivers`
  })
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
  /** The concrete formats it must deliver (`stepOptions.binaryOutput.mediaTypes`). */
  requestedMediaTypes?: string[]
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
  lines.push(
    ...requirementLines(input.requestedModalities, input.requestedMediaTypes ?? [], selected),
  )
  return lines
}

/**
 * What this step OWES, and what nothing selected can be shown to deliver.
 *
 * The format half is the half the agent can act on: it is the party that names the container on
 * the vendor call (`target_formats` and its equivalents), and a generator asked for nothing in
 * particular returns whatever it defaults to. So the required formats are stated as EXACT strings
 * to request, and substitution is refused in words — a step that must deliver FBX is not served
 * by a GLB, however much the file "is" the same mesh.
 *
 * The unverifiable case is stated as its own sentence rather than folded into either the plain
 * requirement or the uncovered warning. Told nothing, an agent proceeds as if the format were
 * confirmed available; told "no integration produces it", it reports a gap that may not exist and
 * skips work it could have done. Neither is what "this integration did not say" means.
 */
function requirementLines(
  modalities: BinaryModality[],
  mediaTypes: string[],
  selected: BinaryGeneratorView[],
): string[] {
  if (modalities.length === 0 && mediaTypes.length === 0) return []
  const lines: string[] = []
  if (modalities.length > 0) {
    lines.push(`This step is expected to deliver: ${modalities.map(describeModality).join(', ')}.`)
    const covered = new Set(selected.flatMap((generator) => generator.modalities))
    const uncovered = modalities.filter((modality) => !covered.has(modality))
    if (uncovered.length > 0) {
      lines.push(
        `No available integration produces ${uncovered.map(describeModality).join(', ')}. Do not attempt to produce ${uncovered.length === 1 ? 'it' : 'them'} another way — deliver the rest and report this gap by name.`,
      )
    }
  }
  if (mediaTypes.length > 0) {
    const list = mediaTypes.map((mediaType) => `\`${mediaType}\``).join(', ')
    // The formats can be the ONLY requirement a step states, so the sentence carries its own
    // subject when the modality line above it did not run.
    const subject = modalities.length > 0 ? 'It' : 'This step'
    lines.push(
      `${subject} must deliver ${mediaTypes.length === 1 ? 'this exact format' : 'each of these exact formats'}: ${list}. Ask the integration for ${mediaTypes.length === 1 ? 'it' : 'them'} by name where its API lets you choose an output format, and do not substitute another container — the consumer of these files accepts ${mediaTypes.length === 1 ? 'this one' : 'these'} and not a near equivalent. Report the media type you stored for each artifact.`,
    )
    const { uncovered, unverifiable } = binaryFormatCoverage(mediaTypes, selected)
    if (uncovered.length > 0) {
      lines.push(
        `No available integration declares that it emits ${uncovered.map((m) => `\`${m}\``).join(', ')}. Do not substitute another format — deliver the rest and report this gap by name.`,
      )
    }
    if (unverifiable.length > 0) {
      lines.push(
        `${unverifiable.map((m) => `\`${m}\``).join(', ')} ${unverifiable.length === 1 ? 'is' : 'are'} not among the formats any selected integration declares, and at least one of them declares no formats at all — so whether it can emit ${unverifiable.length === 1 ? 'this' : 'these'} is unknown rather than settled either way. Check its API contract before generating, and if it cannot, report that instead of storing a different format.`,
      )
    }
  }
  lines.push('')
  return lines
}

/**
 * What the agent is told about an integration's credential — including that it may not be there.
 *
 * THREE cases, not two, because `required` is a real declaration and collapsing it changes what
 * the agent does. A REQUIRED credential that did not arrive means the integration must not be
 * called; an OPTIONAL one (declared for an endpoint that genuinely works unauthenticated) means
 * exactly the opposite — call it anyway. Telling an optional integration's agent "do not call it
 * at all" would strand a working endpoint on the most ordinary misconfiguration there is, which
 * is the failure `required: false` exists to prevent.
 */
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
  const provided = `The credential for \`${generator.id}\` is provided to your process as the environment variable \`${credential.key}\`.${usage} Read it from the environment — never echo it, log it, commit it, or put it in your reply.`
  // `required` defaults to TRUE: an integration whose declaration says nothing is authenticated,
  // which is the safe reading — being wrong that way costs a reported gap, while being wrong the
  // other way burns the run on a call that 401s.
  if (credential.required === false) {
    return [
      provided,
      `\`${credential.key}\` is OPTIONAL for \`${generator.id}\`: if it is unset or empty, still call the integration, unauthenticated as its contract describes. Report a rejection rather than inventing a key.`,
    ]
  }
  return [
    provided,
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
