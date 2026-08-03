import { ASSET_STORAGE_CAPABILITY } from '@cat-factory/contracts'
import type { BinaryModality, RegisteredBinaryGenerator } from '@cat-factory/contracts'
import type {
  BinaryOutputArtifact,
  BinaryOutputConfig,
  BinaryOutputReport,
  PipelineStep,
} from '~/types/execution'
import type { ResolvedFoundationalService } from '~/types/domain'

// ---------------------------------------------------------------------------
// The read model behind the binary-output surface
// (docs/initiatives/binary-output-foundational-storage.md).
//
// A step whose kind carries the `binary-output` trait delivers BINARY artifacts through a
// foundational service its step selected, and declares what it stored in a fenced block the
// engine parses onto `step.binaryOutputs`. That parse deliberately keeps every failure mode
// apart — `undeclared` ≠ `parseFailed` ≠ an empty `stored`, with `invalidEntries` / `omitted`
// / `unknownServices` counted or named rather than absorbed — so the whole job of this module
// is to NOT collapse them again on the way to a renderer.
//
// Pure: it reads the step's own recorded report and its own recorded selection, and nothing
// else. That is deliberate — the join a human actually wants ("did it go where I pointed
// it?") is answerable from those two alone, so the surface needs no catalog fetch and reads
// identically for a run whose services were withdrawn afterwards.
// ---------------------------------------------------------------------------

/**
 * What a step's binary-output record says happened, as one discriminant. Every member is a
 * DIFFERENT fact with a different fix, and the renderer keys its copy off an exhaustive map so
 * a sixth member fails the typecheck rather than rendering a missing key.
 *
 * There is deliberately no "was never briefed" member: that is {@link binaryOutputView}
 * returning null and the surface disappearing, exactly as the effort and validation sections
 * do. A row saying "no binary output was expected here" would ride every step of every run.
 */
export type BinaryOutputState =
  /** The step selected a storage service and has not started yet, so there is nothing to have
   *  recorded. Its own fact, for the same reason a SKIPPED step renders nothing: `configured`
   *  says "running, or it died", and a queued step is neither. What it does say is worth
   *  saying — this is where the artifacts will land — so it renders rather than disappearing. */
  | 'not-started'
  /** The step STARTED, selected a storage service, and no declaration has been recorded — it is
   *  still running, or it died before settlement. NOT "stored nothing". */
  | 'configured'
  /** The step settled and its reply carried no declaration block at all. The agent may or may
   *  not have stored something; nothing was recorded either way. */
  | 'undeclared'
  /** A declaration block was present and unreadable. Same practical outcome as `undeclared`,
   *  different cause — and the only one of the two that is a prompt/model problem. */
  | 'parse-failed'
  /** The agent explicitly declared it stored nothing. A legitimate outcome, not an error. */
  | 'declared-none'
  /** The agent declared artifacts; {@link BinaryOutputView.rows} holds them. */
  | 'stored'

/** One declared artifact, with the two judgements the step's own record supports. */
export interface BinaryOutputRow extends BinaryOutputArtifact {
  /**
   * The artifact was stored through a service OTHER than the one this step selected. Not an
   * error the platform can settle — the agent may have had a reason — but it is the question a
   * human opens this surface to answer, and nothing else records it.
   */
  misdirected: boolean
  /** The named service was not in the resolved catalog when the declaration was parsed. */
  unknown: boolean
  /**
   * The named GENERATIVE INTEGRATION (`artifact.generator`) was not one the deployment registers
   * when the declaration was parsed. The generative twin of {@link unknown}, and kept as its own
   * flag for the same reason the two unknown-id lists are: the fixes live in different places —
   * an unknown service is workspace catalog state, an unknown integration is the deployment's
   * build. A row that claims NO generator is not unknown, it is unattributed, which is a legal
   * state (a model with native image output generates without a registered integration).
   */
  generatorUnknown: boolean
}

/** The whole surface's read model: one state, the join, and every loss the report counted. */
export interface BinaryOutputView {
  state: BinaryOutputState
  /**
   * The storage service the STEP selected (`stepOptions.binaryOutput.storageServiceId`), or
   * null when the step carries no selection. Null is a real state, not a gap to hide: a
   * trait-carrying kind dispatched under an OVERRIDING kind records a declaration against a
   * step that never held the selection, so there is genuinely nothing to compare against and
   * the surface must say so rather than implying the artifacts went astray.
   */
  target: string | null
  /** The context services the step selected, in selection order. */
  contextServices: readonly string[]
  rows: readonly BinaryOutputRow[]
  /**
   * The step's OWN configured target was not in the resolved catalog when the declaration was
   * parsed — the catalog changed under the run, rather than the agent naming a service that
   * never existed. Different causes, different fixes: re-register the service, versus correct
   * the declaration.
   */
  targetUnknown: boolean
  /**
   * Unknown service ids the AGENT named, verbatim and EXCLUDING the step's own target, which
   * {@link targetUnknown} already owns.
   *
   * The exclusion is what makes the two facts DISJOINT, and it lives here rather than in a
   * renderer on purpose: the report's own `unknownServices` mixes them, so a surface reading it
   * raw either reports the lost target twice or — the way this shipped — labels every unknown
   * id as "this step's own storage service" and drops the invented ones entirely. Two fields
   * that cannot overlap is the only shape where naming one cannot mis-state the other.
   */
  unknownDeclaredServices: readonly string[]
  /**
   * The GENERATIVE INTEGRATIONS the step selected (`stepOptions.binaryOutput.generatorIds`), in
   * selection order. Empty is a real state and not a gap: a step may generate through whatever
   * its agent already has, and its brief says so.
   */
  generators: readonly string[]
  /**
   * The CONTENT TYPES the step declares it must deliver (`stepOptions.binaryOutput.modalities`).
   * Empty ⇒ the step imposes no requirement, so nothing is uncovered by construction.
   */
  modalities: readonly BinaryModality[]
  /**
   * Integration ids the AGENT named that the deployment does not register. The generative twin of
   * {@link unknownDeclaredServices}, and it needs no exclusion to stay disjoint from anything —
   * there is no single "target" integration a step selects, so the report's own list is already
   * the whole fact. Rendering it is not optional: the entries are RETAINED, so dropping the list
   * would leave an artifact attributed to something nobody can look up, with nothing saying so.
   */
  unknownDeclaredGenerators: readonly string[]
  /** Entries dropped because they were not `{ service, location }` objects. */
  invalidEntries: number
  /** Valid entries dropped past the report's cap — so {@link rows} is a PREFIX. */
  omitted: number
  /** How many of {@link rows} went somewhere other than {@link target}. */
  misdirected: number
}

/**
 * The step's binary-output read model, or null when the step has no binary-output story at all
 * (no recorded report AND no storage selection) — which is every step of every stock pipeline,
 * so the surface simply does not render.
 *
 * A step carrying a SELECTION but no report still renders: it was briefed, and "briefed, with
 * nothing recorded" is a fact worth stating on a run that died mid-generation. A step carrying
 * a REPORT but no selection renders too, with a null target (see {@link BinaryOutputView.target}).
 *
 * The one exception is a step SKIPPED by estimate gating: it holds a selection it never ran
 * with, so no state describing a dispatch is true of it, and the panel already marks it as
 * skipped. A skipped step genuinely has no binary-output story, so it takes the same absence as
 * an unbriefed one. A step that has not started YET is the neighbouring case and resolves the
 * other way — it still has a story ahead of it, told by `not-started`. (Either with a REPORT is
 * not reachable — nothing dispatched — but if one ever were, the record wins: a recorded claim
 * is never hidden.)
 */
export function binaryOutputView(step: PipelineStep | null | undefined): BinaryOutputView | null {
  const report = step?.binaryOutputs ?? null
  const config = step?.stepOptions?.binaryOutput ?? null
  if (!report && (!config || step?.skipped)) return null

  const target = config?.storageServiceId ?? null
  const contextServices = config?.contextServiceIds ?? []
  const generators = config?.generatorIds ?? []
  const modalities = config?.modalities ?? []
  if (!report) {
    return {
      // A step still queued has not had the chance to record anything, which is a different
      // fact from having had it and not taken it.
      state: step?.state === 'pending' ? 'not-started' : 'configured',
      target,
      contextServices,
      rows: [],
      targetUnknown: false,
      unknownDeclaredServices: [],
      generators,
      modalities,
      unknownDeclaredGenerators: [],
      invalidEntries: 0,
      omitted: 0,
      misdirected: 0,
    }
  }

  const unknown = new Set(report.unknownServices)
  const unknownGenerators = new Set(report.unknownGenerators)
  const rows: BinaryOutputRow[] = report.stored.map((artifact) => ({
    ...artifact,
    // A null target cannot make anything misdirected: there is no place it was supposed to go.
    misdirected: target !== null && artifact.service !== target,
    unknown: unknown.has(artifact.service),
    // An UNATTRIBUTED row (no `generator` claimed) is not unknown — see the field's own note.
    generatorUnknown: artifact.generator !== undefined && unknownGenerators.has(artifact.generator),
  }))

  return {
    state: reportState(report),
    target,
    contextServices,
    rows,
    targetUnknown: target !== null && unknown.has(target),
    unknownDeclaredServices: report.unknownServices.filter((id) => id !== target),
    generators,
    modalities,
    unknownDeclaredGenerators: report.unknownGenerators,
    invalidEntries: report.invalidEntries,
    omitted: report.omitted,
    misdirected: rows.filter((row) => row.misdirected).length,
  }
}

/**
 * Which failure the report records, in the order the parser can produce them. `parseFailed`
 * and `undeclared` are checked BEFORE the (always empty in those cases) `stored` list, so a
 * missing or unreadable block is never reported as "the agent said it stored nothing".
 */
function reportState(report: BinaryOutputReport): BinaryOutputState {
  if (report.parseFailed) return 'parse-failed'
  if (report.undeclared) return 'undeclared'
  return report.stored.length > 0 ? 'stored' : 'declared-none'
}

/**
 * State → i18n keys, exhaustive over the discriminant so a sixth outcome fails the typecheck
 * here rather than rendering a missing key. It lives beside the discriminant, not in a
 * component, because BOTH surfaces read it: the collapsed section row shows `summary` (a few
 * words, the outcome and nothing else) and the expanded panel shows `detail` (what the outcome
 * means and what, if anything, to do). A single map is what keeps the row from claiming an
 * outcome the panel below it then qualifies away.
 *
 * `stored` has an empty detail on purpose: the artifacts themselves are the statement, and a
 * sentence above them would only restate the list's own length.
 */
export const BINARY_OUTPUT_STATE_KEYS: Record<
  BinaryOutputState,
  { icon: string; tone: string; summary: string; detail: string }
> = {
  'not-started': {
    icon: 'i-lucide-clock',
    tone: 'text-slate-400',
    summary: 'binaryOutput.state.notStarted.summary',
    detail: 'binaryOutput.state.notStarted.detail',
  },
  configured: {
    icon: 'i-lucide-hourglass',
    tone: 'text-slate-300',
    summary: 'binaryOutput.state.configured.summary',
    detail: 'binaryOutput.state.configured.detail',
  },
  undeclared: {
    icon: 'i-lucide-circle-help',
    tone: 'text-amber-300',
    summary: 'binaryOutput.state.undeclared.summary',
    detail: 'binaryOutput.state.undeclared.detail',
  },
  'parse-failed': {
    icon: 'i-lucide-file-warning',
    tone: 'text-amber-300',
    summary: 'binaryOutput.state.parseFailed.summary',
    detail: 'binaryOutput.state.parseFailed.detail',
  },
  'declared-none': {
    icon: 'i-lucide-circle-slash',
    tone: 'text-slate-300',
    summary: 'binaryOutput.state.declaredNone.summary',
    detail: 'binaryOutput.state.declaredNone.detail',
  },
  stored: {
    icon: 'i-lucide-package-check',
    tone: 'text-emerald-300',
    summary: 'binaryOutput.state.stored.summary',
    detail: '',
  },
}

/**
 * Whether the view carries any qualification a reader must see beside the artifacts —
 * unknown service ids, dropped entries, a truncated list, or a misdirected artifact. Drives
 * the collapsed summary row's tone, so a report with losses can't read as a clean one from
 * the outside of a collapsed section.
 */
export function binaryOutputHasWarnings(view: BinaryOutputView): boolean {
  return (
    view.state === 'parse-failed' ||
    view.state === 'undeclared' ||
    view.targetUnknown ||
    view.unknownDeclaredServices.length > 0 ||
    view.unknownDeclaredGenerators.length > 0 ||
    view.invalidEntries > 0 ||
    view.omitted > 0 ||
    view.misdirected > 0
  )
}

// ---------------------------------------------------------------------------
// The pipeline builder's half: what is wrong with a step's SELECTION, before it is saved.
// ---------------------------------------------------------------------------

/**
 * One thing wrong with a binary-generating step's selection, as the builder can see it.
 *
 * The two `*_service` members mirror the kernel's `BinaryOutputConfigIssue.problem` values
 * VERBATIM, because the builder's job here is to surface the run-admission refusal
 * (`binary_output_service_invalid`) BEFORE the round trip rather than to invent a second
 * opinion about the same catalog. They are restated rather than imported: the SPA cannot see
 * kernel, and the wire vocabulary that crosses to it (`@cat-factory/contracts`) carries the
 * error code, not the issue enum. The remaining three are conditions the BUILDER alone can be
 * in — nothing is picked yet, or there is nothing to pick from.
 */
export type BinaryOutputPickIssue =
  /** The catalog read failed (the feature is unconfigured, or the request 503'd). Not the same
   *  as an empty catalog: an empty picker reads as "no services exist", which is a claim. */
  | 'catalog_unavailable'
  /** The catalog resolved, but nothing in it declares the `asset-storage` capability. */
  | 'no_storage_service'
  /** The deployment's registered integrations could not be READ (a mothership-mode node whose
   *  mothership is unreachable). Kept apart from an empty set for the same reason
   *  `catalog_unavailable` is: an empty picker is a claim about the deployment's BUILD, and
   *  acting on it during an outage sends someone looking in the wrong repository. */
  | 'generators_unavailable'
  /** An enabled generator step with no storage selection — refused at save AND at start. */
  | 'not_selected'
  /** The selected storage id is not in the resolved catalog (kernel's `unknown_service`). */
  | 'unknown_service'
  /** The selected storage service dropped its `asset-storage` tag (kernel's own spelling). */
  | 'not_storage_capable'
  /** One or more selected CONTEXT ids are not in the resolved catalog. */
  | 'unknown_context_service'
  /**
   * A selected GENERATIVE INTEGRATION is not one this deployment registers (kernel's
   * `BinaryGeneratorSelectionIssue.problem` spelling verbatim, like the two `*_service` members).
   */
  | 'unknown_generator'
  /** A content type the step declares it delivers is produced by NO selected integration. */
  | 'modality_uncovered'

/** What the builder found wrong with one step's selection, and which ids to name. */
export interface BinaryOutputPickState {
  issues: readonly BinaryOutputPickIssue[]
  /** The unresolved CONTEXT ids, for the message that names them. */
  unknownContextIds: readonly string[]
  /** The unregistered GENERATIVE INTEGRATION ids, for the message that names them. */
  unknownGeneratorIds: readonly string[]
  /** The declared content types nothing selected can produce, for the message that names them. */
  uncoveredModalities: readonly BinaryModality[]
}

/**
 * The GENERATIVE half of {@link binaryOutputPickIssues}, mirroring kernel's
 * `binaryGeneratorSelectionIssues` so the builder surfaces the `binary_output_generator_invalid`
 * refusal before the round trip rather than inventing a second opinion.
 *
 * `unavailable` is the one state that is NOT derivable from the list, which is why the snapshot
 * carries it as its own flag. An empty list normally IS a real empty — this deployment registers
 * none — and that is exactly why a selected id in that state is `unknown_generator` rather than
 * silence. But on a mothership-mode deployment the set is read from the mothership, and a failed
 * read is the same empty list about a completely different fact. Reporting `unknown_generator`
 * there would tell someone their step names an integration nobody registered, about an id that
 * is very likely fine — the same misattribution the backend refuses to make at admission. So an
 * unavailable set reports THAT and stops: every other judgement below is a claim about a list
 * nobody managed to read.
 */
function generatorPickIssues(
  config: BinaryOutputConfig | undefined,
  generators: readonly Pick<RegisteredBinaryGenerator, 'id' | 'modalities'>[],
  unavailable: boolean,
): { issues: BinaryOutputPickIssue[]; unknownGeneratorIds: string[]; uncovered: BinaryModality[] } {
  if (unavailable) {
    return { issues: ['generators_unavailable'], unknownGeneratorIds: [], uncovered: [] }
  }
  const byId = new Map(generators.map((g) => [g.id, g]))
  const selectedIds = config?.generatorIds ?? []
  const unknownGeneratorIds = selectedIds.filter((id) => !byId.has(id))
  // Coverage is judged against what RESOLVED, exactly as admission judges it: an unknown id
  // contributes no content types, so a step whose only audio generator is unregistered is told
  // BOTH things — the id is gone, and the requirement it was covering is now uncovered.
  const covered = new Set(selectedIds.flatMap((id) => byId.get(id)?.modalities ?? []))
  const uncovered = (config?.modalities ?? []).filter((m) => !covered.has(m))
  const issues: BinaryOutputPickIssue[] = []
  if (unknownGeneratorIds.length) issues.push('unknown_generator')
  if (uncovered.length) issues.push('modality_uncovered')
  return { issues, unknownGeneratorIds, uncovered }
}

/**
 * Validate a step's selection against the workspace's RESOLVED catalog — the same catalog run
 * admission re-validates against, which is the whole reason the picker offers only resolved
 * services: an id offered from a stale client copy saves clean and fails at run START, one
 * refusal cycle later.
 *
 * `available` is the catalog's own probe state, threaded separately because it distinguishes
 * three things an empty array cannot: NOT PROBED YET (`null`), UNREACHABLE (`false`) and
 * genuinely EMPTY (`true`) — opposite facts with opposite fixes, and only the last is worth a
 * "register a storage service" hint. Every judgement about the CATALOG therefore requires
 * `available === true`; only `not_selected`, which is a fact about the STEP, holds regardless.
 * Without that a step would be flagged for re-pick during the load that is about to resolve it,
 * and again during an outage that changed nothing about it.
 *
 * Returns EVERY issue, not the first, for the same reason `binaryOutputConfigIssues` does:
 * naming one at a time costs a fix-and-retry cycle per lost service. The ONE subsumption is
 * `no_storage_service`, which suppresses the per-selection storage judgements below it: both
 * of those tell the user to pick another service, and there is none to pick — an instruction
 * the surface cannot carry out is worse than silence, and the remedy that IS actionable
 * (register one) is already stated. The CONTEXT half is unaffected: it is a different
 * selection, judged on existence alone, and stays actionable whatever the storage tier looks
 * like.
 */
export function binaryOutputPickIssues(
  config: BinaryOutputConfig | undefined,
  catalog: readonly Pick<ResolvedFoundationalService, 'id' | 'capabilities'>[],
  available: boolean | null,
  // Defaulted to EMPTY, the same reading `RunAdmission` gives an unwired registry: a deployment
  // that registers no integrations cannot satisfy a step that selects one. So a call site that
  // omits this FLAGS a selection rather than passing it — the loud direction — and the default
  // stays a legitimate value rather than a hole.
  generators: readonly Pick<RegisteredBinaryGenerator, 'id' | 'modalities'>[] = [],
  // Whether the deployment's integrations could not be READ. Defaulted to `false` — the honest
  // default, since every deployment but a mothership-mode node reads them in-process and cannot
  // fail — so an omitting call site judges the list it was given rather than claiming an outage.
  generatorsUnavailable = false,
): BinaryOutputPickState {
  const resolved = available === true
  const issues: BinaryOutputPickIssue[] = []
  // Judged FIRST and outside the `not_selected` early return below, because the two halves
  // resolve against different registries and a step missing its storage pick routinely has a
  // generative fault too. Reporting them one round at a time is exactly the fix-and-retry cycle
  // this function returns every issue to avoid.
  const generative = generatorPickIssues(config, generators, generatorsUnavailable)
  const noStorageService =
    resolved && !catalog.some((s) => s.capabilities.includes(ASSET_STORAGE_CAPABILITY))
  if (available === false) issues.push('catalog_unavailable')
  else if (noStorageService) issues.push('no_storage_service')

  const storageId = config?.storageServiceId?.trim()
  if (!storageId) {
    issues.push('not_selected')
    return {
      issues: [...issues, ...generative.issues],
      unknownContextIds: [],
      unknownGeneratorIds: generative.unknownGeneratorIds,
      uncoveredModalities: generative.uncovered,
    }
  }

  if (resolved && !noStorageService) {
    const storage = catalog.find((s) => s.id === storageId)
    if (!storage) issues.push('unknown_service')
    else if (!storage.capabilities.includes(ASSET_STORAGE_CAPABILITY))
      issues.push('not_storage_capable')
  }

  const known = new Set(catalog.map((s) => s.id))
  const unknownContextIds = resolved
    ? (config?.contextServiceIds ?? []).filter((id) => !known.has(id))
    : []
  if (unknownContextIds.length) issues.push('unknown_context_service')

  return {
    issues: [...issues, ...generative.issues],
    unknownContextIds,
    unknownGeneratorIds: generative.unknownGeneratorIds,
    uncoveredModalities: generative.uncovered,
  }
}
