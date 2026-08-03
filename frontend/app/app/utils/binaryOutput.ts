import { ASSET_STORAGE_CAPABILITY } from '@cat-factory/contracts'
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
  /** The step selected a storage service but no declaration has been recorded — it is still
   *  running, or it died before settlement. NOT "stored nothing". */
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
  /** Distinct declared service ids the catalog did not contain, verbatim. */
  unknownServices: readonly string[]
  /**
   * The step's OWN configured target is among {@link unknownServices} — the catalog changed
   * under the run, rather than the agent naming a service that never existed. Different
   * causes, different fixes: re-register the service, versus correct the declaration.
   */
  targetUnknown: boolean
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
 */
export function binaryOutputView(step: PipelineStep | null | undefined): BinaryOutputView | null {
  const report = step?.binaryOutputs ?? null
  const config = step?.stepOptions?.binaryOutput ?? null
  if (!report && !config) return null

  const target = config?.storageServiceId ?? null
  const contextServices = config?.contextServiceIds ?? []
  if (!report) {
    return {
      state: 'configured',
      target,
      contextServices,
      rows: [],
      unknownServices: [],
      targetUnknown: false,
      invalidEntries: 0,
      omitted: 0,
      misdirected: 0,
    }
  }

  const unknown = new Set(report.unknownServices)
  const rows: BinaryOutputRow[] = report.stored.map((artifact) => ({
    ...artifact,
    // A null target cannot make anything misdirected: there is no place it was supposed to go.
    misdirected: target !== null && artifact.service !== target,
    unknown: unknown.has(artifact.service),
  }))

  return {
    state: reportState(report),
    target,
    contextServices,
    rows,
    unknownServices: report.unknownServices,
    targetUnknown: target !== null && unknown.has(target),
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
    view.unknownServices.length > 0 ||
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
  /** An enabled generator step with no storage selection — refused at save AND at start. */
  | 'not_selected'
  /** The selected storage id is not in the resolved catalog (kernel's `unknown_service`). */
  | 'unknown_service'
  /** The selected storage service dropped its `asset-storage` tag (kernel's own spelling). */
  | 'not_storage_capable'
  /** One or more selected CONTEXT ids are not in the resolved catalog. */
  | 'unknown_context_service'

/** What the builder found wrong with one step's selection, and which ids to name. */
export interface BinaryOutputPickState {
  issues: readonly BinaryOutputPickIssue[]
  /** The unresolved CONTEXT ids, for the message that names them. */
  unknownContextIds: readonly string[]
}

/**
 * Validate a step's selection against the workspace's RESOLVED catalog — the same catalog run
 * admission re-validates against, which is the whole reason the picker offers only resolved
 * services: an id offered from a stale client copy saves clean and fails at run START, one
 * refusal cycle later.
 *
 * `available` is the catalog's own probe state, threaded separately because `[]` from an
 * unreachable catalog and `[]` from an empty one are opposite facts with opposite fixes, and
 * only one of them is worth a "register a storage service" hint.
 *
 * Returns EVERY issue, not the first, for the same reason `binaryOutputConfigIssues` does:
 * naming one at a time costs a fix-and-retry cycle per lost service.
 */
export function binaryOutputPickIssues(
  config: BinaryOutputConfig | undefined,
  catalog: readonly Pick<ResolvedFoundationalService, 'id' | 'capabilities'>[],
  available: boolean | null,
): BinaryOutputPickState {
  const issues: BinaryOutputPickIssue[] = []
  if (available === false) issues.push('catalog_unavailable')
  else if (!catalog.some((s) => s.capabilities.includes(ASSET_STORAGE_CAPABILITY)))
    issues.push('no_storage_service')

  const storageId = config?.storageServiceId?.trim()
  if (!storageId) {
    issues.push('not_selected')
    return { issues, unknownContextIds: [] }
  }

  // Only judge a SELECTED id against a catalog we actually have. An unreachable catalog would
  // otherwise report every selection as unknown — flagging a step for re-pick over an outage
  // that changed nothing about it.
  if (available !== false) {
    const storage = catalog.find((s) => s.id === storageId)
    if (!storage) issues.push('unknown_service')
    else if (!storage.capabilities.includes(ASSET_STORAGE_CAPABILITY))
      issues.push('not_storage_capable')
  }

  const known = new Set(catalog.map((s) => s.id))
  const unknownContextIds =
    available === false ? [] : (config?.contextServiceIds ?? []).filter((id) => !known.has(id))
  if (unknownContextIds.length) issues.push('unknown_context_service')

  return { issues, unknownContextIds }
}
