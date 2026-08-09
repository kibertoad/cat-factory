import {
  binaryCapabilityCoverage,
  binaryCapabilityProviders,
  binaryFormatCoverage,
  binaryGeneratorCredentialEnvName,
  binaryModalityOverlaps,
  requiredBinaryCapabilities,
} from '@cat-factory/contracts'
import type {
  BinaryGenerationOptions,
  BinaryGeneratorCapability,
  BinaryModality,
  BinaryOutputConfig,
} from '@cat-factory/contracts'
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
  // Deliberately NO `capabilities` here. The dispatch projection exists so the container executor
  // can resolve each credential without the registry, and what an integration SUPPORTS is stated
  // to the agent in its brief, which is rendered from the registry view. Carrying it a second time
  // would put a copy on the wire that nothing reads and that a future reader could believe was
  // authoritative.
  /**
   * The credentials this integration authenticates with, in declaration order. Absent means none
   * is declared, and the executor asks the resolver for nothing.
   *
   * A LIST because an integration can need more than one value to make a single call: HTTP Basic
   * over an API key and an API secret is the ordinary case, and folding both into one variable
   * would make the operator checklist ask for a string the vendor never issues.
   */
  credentials?: ResolvedBinaryGeneratorCredential[]
}

/** One credential on the dispatch projection: names only, never a value. */
export interface ResolvedBinaryGeneratorCredential {
  /**
   * The credential's LOOKUP key, which is what the executor asks the resolver for.
   *
   * This is NOT necessarily what the agent reads: {@link envName} is, and the brief names that
   * one. The two are separate because the lookup key is held to the platform's reserved-variable
   * floor while the injected name is not, so an integration whose client reads a vendor's
   * documented name can keep it.
   */
  key: string
  /**
   * The environment variable the value is delivered as, when it differs from {@link key}. Absent
   * means the lookup key is also the variable.
   *
   * Carried on the projection rather than re-derived, because the executor rebuilds a dispatch
   * from the context alone and has neither the registry nor the step to look the definition up in.
   */
  envName?: string
  /** Whether a missing value means the integration must not be called (defaults true). */
  required?: boolean
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
    // Omitted rather than sent as `[]`, so the projection carries a credential field only for an
    // integration that has one. Every consumer already treats absence as "nothing to resolve".
    ...(generator.credentials.length > 0
      ? {
          credentials: generator.credentials.map((credential) => ({
            key: credential.key,
            ...(credential.envName ? { envName: credential.envName } : {}),
            ...(credential.required === false ? { required: false } : {}),
          })),
        }
      : {}),
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
  /**
   * A per-step GENERATION OPTION whose capability no selected integration declares: a reference
   * image handed to an endpoint that takes no image input, a mask edit asked of an API that only
   * rewrites whole pictures, a seed asked of one that has none.
   *
   * The third axis of the same rule the two above enforce, and refused for the same reason: an
   * unsupported parameter is not a thinner generation. Either the call is rejected, which burns
   * the run, or it succeeds having silently ignored the one input that made the step's output
   * correct, which is worse because every downstream check passes.
   *
   * Only ever raised against integrations that DECLARED their capabilities. The third outcome
   * ({@link binaryCapabilityCoverage}'s `unverifiable`) is not an issue, which is what keeps
   * every integration registered before this axis existed running unchanged.
   */
  | { problem: 'capability_unsupported'; capability: BinaryGeneratorCapability }

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
 *
 * A repeated id resolves ONCE, on its first appearance. Nothing refuses a stored selection that
 * names one integration twice, and every reader downstream of this states a COUNT of some kind:
 * left in, the brief renders that integration's whole entry a second time (an agent reading two
 * identical entries has been told nothing and charged tokens for it) and an overlap report would
 * say a step holds two producers of what it holds one of.
 */
export function resolveBinaryGeneratorSelection(
  config: BinaryOutputConfig | undefined,
  generators: readonly BinaryGeneratorView[],
): ResolvedBinaryGeneratorSelection {
  const byId = new Map(generators.map((generator) => [generator.id, generator]))
  const selected: BinaryGeneratorView[] = []
  const unresolvedIds: string[] = []
  const seen = new Set<string>()
  for (const id of config?.generatorIds ?? []) {
    if (seen.has(id)) continue
    seen.add(id)
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
  // Only the UNCOVERED half refuses. An unverifiable format is reported to the agent by the brief
  // and to the composer by the picker, and admitting it is the point: see `binaryFormatCoverage`.
  for (const mediaType of binaryFormatCoverage(config?.mediaTypes ?? [], selected).uncovered) {
    issues.push({ problem: 'media_type_uncovered', mediaType })
  }
  // The GENERATION OPTIONS, judged the same way and for the same reason. The requirement is
  // DERIVED from what the step actually asks for rather than declared, so a step is never refused
  // over a capability it does not exercise: one reference image needs `reference-image` and not
  // `multi-reference`, and an edit needs exactly the one capability its mode names.
  for (const capability of binaryCapabilityCoverage(
    requiredBinaryCapabilities(config?.generation),
    selected,
  ).uncovered) {
    issues.push({ problem: 'capability_unsupported', capability })
  }
  return issues
}

/**
 * A capability in words, for a message a human reads.
 *
 * The `default` is here for the reason {@link describeModality}'s is, minus the persistence: this
 * vocabulary is not stored on a step, but a MOTHERSHIP-MODE node resolves its integrations from a
 * process that may be a build AHEAD of it, so a capability this build has never defined arrives
 * over `/internal/binary-generators` and reaches this switch. Falling off the end would render it
 * `undefined` inside the one sentence whose job is to say what a selection cannot do.
 */
export function describeCapability(capability: BinaryGeneratorCapability): string {
  switch (capability) {
    case 'reference-image':
      return 'conditioning a generation on a reference image'
    case 'multi-reference':
      return 'combining several reference images in one generation'
    case 'instruction-edit':
      return 'editing an existing artifact from a written instruction'
    case 'mask-edit':
      return 'editing only the region an image mask names'
    case 'negative-prompt':
      return 'a negative prompt (what to keep out)'
    case 'seed':
      return 'a fixed seed'
    case 'aspect-ratio':
      return 'an explicit aspect ratio'
    case 'exact-size':
      return 'exact output dimensions in pixels'
    case 'candidate-batch':
      return 'returning several candidates from one call'
    case 'upscale':
      return 'upscaling its own output'
    case 'transparent-background':
      return 'a transparent background'
    case 'tileable':
      return 'a seamlessly tiling image'
    default:
      return describeUnknownCapability(capability)
  }
}

/**
 * A capability this build does not define, named as the unknown value it is.
 *
 * Takes `never`, so adding a member without a case still fails the typecheck while a value from a
 * newer mothership is still described honestly. Deliberately not mapped onto a neighbour: nothing
 * here knows what it means, and inventing a description would put a claim about a vendor's API in
 * front of whoever is deciding what to ask that API for.
 */
function describeUnknownCapability(capability: never): string {
  return `'${String(capability)}' (a capability this deployment does not define)`
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
    if (issue.problem === 'capability_unsupported') {
      return `this step's generation options ask for ${describeCapability(issue.capability)}, and no selected integration supports it: remove the option, or select an integration that declares the capability`
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
 * other's output; it names the OVERLAP where that per-content-type rule stops deciding
 * ({@link overlapLines}); it names the credential's ENVIRONMENT VARIABLE and says what an unset
 * one means (the platform could not provide it: do not call, report), because the agent is the
 * only party that can see whether the value arrived; and it states an unresolved id rather than
 * dropping it, because a selection that silently shrinks reads as a step nobody configured.
 */
export function renderBinaryGeneratorSection(input: {
  selection: ResolvedBinaryGeneratorSelection
  /** The content types the step declares it must deliver (`stepOptions.binaryOutput.modalities`). */
  requestedModalities: BinaryModality[]
  /** The concrete formats it must deliver (`stepOptions.binaryOutput.mediaTypes`). */
  requestedMediaTypes?: string[]
  /** The parameters every generation carries (`stepOptions.binaryOutput.generation`). */
  generation?: BinaryGenerationOptions
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
    lines.push(...overlapLines(selected))
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
  lines.push(...generationOptionLines(input.generation, selected))
  return lines
}

/**
 * The step's GENERATION OPTIONS as instructions: the parameters every call must carry, which
 * integrations will honour each, and the ones nothing selected can be shown to support.
 *
 * Stated in the platform's own vocabulary and never in any vendor's, because the agent writes the
 * request and only it knows what the endpoint in front of it calls a seed. "Send a negative
 * prompt of X" is actionable against four different APIs; `negative_prompt=X` is actionable
 * against one and wrong for the others.
 *
 * Three things it refuses to leave silent, each because silence is read as permission:
 *
 * - A reference or a mask that is a LOCATION rather than an attachment. The platform never
 *   fetches these, so an agent that is not told where the file lives will generate without it and
 *   report success.
 * - Which integrations honour an option, once more than one is selected. An aspect ratio honoured
 *   by one of two producers is not a covered requirement in any useful sense, and the artifact it
 *   comes back on carries no trace of which one made it.
 * - An UNVERIFIABLE option: nothing selected declares the capability and at least one declared no
 *   capabilities at all. Told nothing, the agent proceeds as if it were confirmed; told "nothing
 *   supports this", it drops an option that very likely works. Neither is what the state means,
 *   so it gets its own sentence pointing at the contract.
 */
function generationOptionLines(
  generation: BinaryGenerationOptions | undefined,
  selected: BinaryGeneratorView[],
): string[] {
  const required = requiredBinaryCapabilities(generation)
  if (!generation || required.length === 0) return []
  const lines: string[] = [
    'These generation options apply to EVERY artifact this step produces:',
    '',
  ]
  for (const reference of generation.referenceImages ?? []) {
    lines.push(
      `- Reference image (${reference.role}): ${assetPointer(reference)}${reference.note ? ` ${reference.note}` : ''}`,
    )
  }
  if (generation.edit) {
    const edit = generation.edit
    lines.push(
      `- This step EDITS existing artifacts (${edit.mode === 'mask' ? 'masked region only' : 'whole-artifact instruction'}) rather than generating from nothing.${edit.instruction ? ` What to change: ${edit.instruction}` : ''}`,
    )
    lines.push(
      edit.source
        ? `  - The artifact to revise: ${assetPointer(edit.source)}`
        : '  - Which existing artifact each generation revises comes from the scope services below, not from this step.',
    )
    if (edit.mode === 'mask') {
      lines.push(
        edit.mask
          ? `  - The mask: ${assetPointer(edit.mask)}`
          : '  - NO mask was configured for this masked edit. Do not fall back to editing the whole artifact: report that the mask was missing.',
      )
    }
  }
  if (generation.negativePrompt) lines.push(`- Negative prompt: ${generation.negativePrompt}`)
  if (generation.seed !== undefined) {
    lines.push(
      `- Seed: ${generation.seed}. Send it on every call so this run can be reproduced; vary it only where you are explicitly asked for several candidates of one subject.`,
    )
  }
  if (generation.aspectRatio) lines.push(`- Aspect ratio: ${generation.aspectRatio}`)
  if (generation.outputSize) {
    const { width, height } = generation.outputSize
    lines.push(
      `- Output size: EXACTLY ${width}x${height} pixels, for every artifact measured in pixels (images and video; it says nothing about audio, 3D or documents). This is a requirement of the deliverable, not a preference, and it is stated as a size because the size is what the step is for: generating larger and downscaling is a different asset, not the same one delivered carefully. Ask for these dimensions on the call. If the integration you are calling cannot be asked for them, or rejects them (a maximum, a grid it rounds to, a range tied to the style), say so in your report and declare the size you actually delivered rather than substituting one silently.`,
    )
  }
  if (generation.upscale !== undefined) {
    lines.push(`- Upscale the result ${generation.upscale}x where the integration offers it.`)
  }
  if (generation.transparentBackground) {
    lines.push(
      '- Deliver a TRANSPARENT background (an alpha channel), not a matted or filled one. Choose an output format that carries alpha.',
    )
  }
  if (generation.tileable) {
    lines.push('- Deliver a SEAMLESSLY TILING image, not one that merely looks repeatable.')
  }
  lines.push('')
  const providers = binaryCapabilityProviders(required, selected)
  if (selected.length > 1 && providers.length > 0) {
    lines.push(
      'Not every integration honours every option:',
      '',
      ...providers.map(
        (entry) =>
          `- ${describeCapability(entry.capability)}: ${joinIds(entry.generatorIds)}.` +
          (entry.generatorIds.length < selected.length
            ? ' The others do not declare it, so do not send it to them and say so in your report if the option mattered.'
            : ''),
      ),
      '',
    )
  }
  const coverage = binaryCapabilityCoverage(required, selected)
  if (coverage.unverifiable.length > 0) {
    lines.push(
      `No selected integration declares support for ${coverage.unverifiable.map(describeCapability).join(', ')}, and at least one of them declares no capabilities at all, so whether it can is unknown rather than settled. Check its API contract before relying on ${coverage.unverifiable.length === 1 ? 'it' : 'them'}, and report the gap rather than generating as if the option had been applied.`,
      '',
    )
  }
  return lines
}

/** Where a referenced asset lives, in whichever of the two addressings the step used. */
function assetPointer(ref: { location: string; service?: string }): string {
  return ref.service
    ? `\`${ref.location}\` in the \`${ref.service}\` service (fetch it through that service's API; it is not attached to this job)`
    : `\`${ref.location}\` (fetch it yourself; it is not attached to this job)`
}

/**
 * The content types more than one selected integration produces, and what to do about it.
 *
 * The section's routing rule ("never ask one for a kind of output it does not produce") is stated
 * per CONTENT TYPE, and it is complete only while the content type determines the integration.
 * Hand an agent two image APIs and it under-determines in silence: every artifact is an image,
 * both produce images, and nothing has said that a choice is being made. What follows is not a
 * random error, which is what makes it worth a paragraph. The agent picks one and keeps picking
 * it, for every artifact of the run, and the result is the wrong kind of correct at the price of
 * the right one, on a file whose modality, format and storage verdict all check out.
 *
 * So this states the fact and refuses to state a preference. The platform has no cost model, no
 * quality model and no view of what the step is for, and a confident wrong preference is worse
 * than none because it displaces the per-integration notes the agent would otherwise have read.
 * It is computed from the RESOLVED selection alone and never the registry, because a step is not
 * affected by integrations it did not select, and never from the step's REQUIREMENTS, because the
 * case that motivates selecting two producers is routinely the one where neither is the
 * deliverable (concept art generated to feed a mesh API's image path).
 *
 * It renders after the per-integration entries so that "the notes above" is literally true: those
 * descriptions are what the choice is actually made from, and this paragraph's only job is to
 * make the agent notice that it is deciding. Silent with no overlap, because a paragraph that
 * rides every brief is one agents stop reading.
 *
 * It also asks for the `generator` field the declaration block treats as optional. Optional is
 * right in general: most steps hold one producer per content type and the answer is not in doubt.
 * The moment two are held it becomes the ONLY record of a choice nothing downstream can check,
 * and without it nobody can tell afterwards that forty sprites came from the wrong one.
 */
function overlapLines(selected: BinaryGeneratorView[]): string[] {
  const overlaps = binaryModalityOverlaps(selected)
  if (overlaps.length === 0) return []
  return [
    'More than one of these integrations produces the same kind of output, so the content type does not tell you which to call:',
    '',
    ...overlaps.map(
      (overlap) =>
        `- ${joinIds(overlap.generatorIds)} ${overlap.generatorIds.length === 2 ? 'both' : 'all'} produce ${describeModality(overlap.modality)}.`,
    ),
    '',
    "They are not interchangeable. Read each one's notes above and choose per artifact; where this step's own instructions say which to use, those decide. Record the integration you used in each entry's `generator` field, so the choice is on the record.",
    '',
  ]
}

/** `` `a` and `b` ``; `` `a`, `b` and `c` ``. Total for any length, including the empty list. */
function joinIds(ids: readonly string[]): string {
  const quoted = ids.map((id) => `\`${id}\``)
  return [quoted.slice(0, -1).join(', '), ...quoted.slice(-1)].filter(Boolean).join(' and ')
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
 * What the agent is told about an integration's credentials, including that they may not be
 * there.
 *
 * THREE dispositions, not two, because `required` is a real declaration and collapsing it changes
 * what the agent does. A REQUIRED credential that did not arrive means the integration must not be
 * called; an OPTIONAL one (declared for an endpoint that genuinely works unauthenticated) means
 * exactly the opposite — call it anyway. Telling an optional integration's agent "do not call it
 * at all" would strand a working endpoint on the most ordinary misconfiguration there is, which
 * is the failure `required: false` exists to prevent.
 *
 * With more than one value the same disposition is stated JOINTLY, and that sentence is the whole
 * reason a pair is two declarations rather than one colon-joined string. Told per variable that a
 * missing one means "do not call", an agent holding an API key whose secret did not resolve has
 * been told something true about each half and nothing about the request it is about to write,
 * and the plausible reading (send what arrived) costs the run a 401 it will read as a wrong key.
 */
function credentialLines(generator: BinaryGeneratorView): string[] {
  if (generator.credentials.length === 0) {
    return [
      `No credential is configured for \`${generator.id}\`: call it unauthenticated as its contract describes, and report a rejection rather than inventing a key.`,
    ]
  }
  // The INJECTION name, never the lookup key. They differ whenever a definition had to keep a
  // vendor's documented variable name while looking the value up under one of its own, and naming
  // the lookup key here would tell the agent to read a variable that is never set: an integration
  // reported as unavailable on every run, with the brief itself as the reason nobody could see it.
  //
  // `required` defaults to TRUE: an integration whose declaration says nothing is authenticated,
  // which is the safe reading. Being wrong that way costs a reported gap, while being wrong the
  // other way burns the run on a call that 401s.
  const credentials = generator.credentials.map((credential) => ({
    envName: binaryGeneratorCredentialEnvName(credential),
    usage: credential.usage,
    required: credential.required !== false,
  }))
  const [only] = credentials
  const lines =
    credentials.length === 1 && only
      ? [
          `The credential for \`${generator.id}\` is provided to your process as the environment variable \`${only.envName}\`.${only.usage ? ` Send it as ${only.usage}.` : ' Its API contract states how to present it.'} Read it from the environment, and never echo it, log it, commit it, or put it in your reply.`,
        ]
      : [
          `\`${generator.id}\` takes ${credentials.length} credential values, each provided to your process as its own environment variable. Read them from the environment, and never echo them, log them, commit them, or put them in your reply.`,
          '',
          ...credentials.map(
            (credential) =>
              `- \`${credential.envName}\`: ${credential.usage ? `send it as ${credential.usage}` : 'its API contract states how to present it'}.`,
          ),
          '',
          'They are parts of ONE credential, not alternatives: a request carrying some of them is not partly authenticated, it is refused. Assemble them exactly as stated above, and never improvise a value for one you were not given.',
        ]
  const required = credentials.filter((credential) => credential.required).map((c) => c.envName)
  const optional = credentials.filter((credential) => !credential.required).map((c) => c.envName)
  if (required.length > 0) {
    lines.push(
      `If ${joinIds(required)} ${required.length === 1 ? 'is' : 'are'} unset or empty, the platform could NOT provide ${required.length === 1 ? 'the credential' : 'that part of the credential'}: do not call \`${generator.id}\` at all, and report that its credential was unavailable. An empty variable is not an empty key.`,
    )
  }
  if (optional.length > 0) {
    lines.push(
      `${joinIds(optional)} ${optional.length === 1 ? 'is' : 'are'} OPTIONAL for \`${generator.id}\`: if ${optional.length === 1 ? 'it is' : 'they are'} unset or empty, still call the integration, ${required.length === 0 ? 'unauthenticated as its contract describes' : `with the ${required.length === 1 ? 'value' : 'values'} above and without ${optional.length === 1 ? 'it' : 'them'}`}. Report a rejection rather than inventing a key.`,
    )
  }
  return lines
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
