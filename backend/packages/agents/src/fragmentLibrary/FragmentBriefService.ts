import type {
  Clock,
  FragmentBriefGenerator,
  FragmentBriefRecord,
  FragmentBriefRepository,
  FragmentOwnerKind,
  Logger,
  ResolvedCatalogEntry,
  StoredFragmentBrief,
} from '@cat-factory/kernel'
import { noopLogger, resolveFragmentBrief, runBestEffort } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Resolves the CONDENSED variant of each standard an implementer dispatch is about to
// fold, generating and persisting one for any long standard that has none.
//
// It hangs off `FragmentLibraryService.resolveBodiesForRun` rather than off the write path
// (create / repo resync / document refresh) on purpose, and the reason is the third source
// of body changes: a document-backed standard is re-resolved from Confluence/Notion AT RUN
// TIME, so there is no write to hook. Resolving here means one seam covers every way a body
// can move, and it is DEMAND-DRIVEN — only the standards an implementer actually receives
// are ever condensed, instead of the whole catalog on the chance someone folds it.
//
// The cost lands once per (fragment, body version): the persisted row is keyed by a
// fingerprint of the body it condensed, so the next dispatch reads it back and every
// subsequent turn of that agent's loop pays nothing.
// ---------------------------------------------------------------------------

export interface FragmentBriefServiceDependencies {
  /** Where generated briefs are persisted; absent ⇒ nothing is generated or stored. */
  repository: FragmentBriefRepository
  /** The condensation model; absent or disabled ⇒ long standards fold in full. */
  generator?: FragmentBriefGenerator
  clock: Clock
  logger?: Logger
}

/** One standard an implementer dispatch is about to fold, with its CURRENT body. */
export interface FragmentBriefCandidate {
  entry: ResolvedCatalogEntry
  /**
   * The body actually being folded — for a document-backed standard the text just
   * re-resolved from the source, NOT the last-persisted snapshot. Passing the snapshot
   * would fingerprint a body the agent never sees, so an edited upstream page would keep
   * serving a brief of its previous revision.
   */
  body: string
}

/** A scope key that survives grouping: the owner pair a brief row is stored under. */
function scopeKey(ownerKind: FragmentOwnerKind, ownerId: string): string {
  return `${ownerKind}:${ownerId}`
}

/**
 * The stored `brief` of a row that records "this body was condensed and the result was not
 * usable" (kernel's `isNotCondensableMarker` reads it back). This service is its ONLY writer.
 */
const NOT_CONDENSABLE = ''

export class FragmentBriefService {
  private readonly repo: FragmentBriefRepository
  private readonly generator?: FragmentBriefGenerator
  private readonly clock: Clock
  private readonly log: Logger

  constructor(deps: FragmentBriefServiceDependencies) {
    this.repo = deps.repository
    this.generator = deps.generator
    this.clock = deps.clock
    this.log = deps.logger ?? noopLogger
  }

  /**
   * The brief to fold for each candidate, keyed by fragment id. An id absent from the map
   * folds its full body — the pre-feature behaviour, and the outcome of EVERY failure mode
   * here (no model wired, an unreadable store, a refused condensation). A brief is an
   * optimisation of how a standard is stated; losing it must never change what it requires,
   * so nothing on this path is allowed to propagate into the dispatch.
   */
  async resolveBriefs(
    workspaceId: string,
    candidates: FragmentBriefCandidate[],
  ): Promise<Map<string, string>> {
    const briefs = new Map<string, string>()
    if (candidates.length === 0) return briefs

    // Pass 1 — settle everything decidable without touching the store: a linked brief wins,
    // and a body under the threshold folds in full (no read, no call).
    const pending: FragmentBriefCandidate[] = []
    for (const candidate of candidates) {
      const decision = resolveFragmentBrief({
        body: candidate.body,
        authoredBrief: candidate.entry.brief,
      })
      if (decision.kind === 'authored') briefs.set(candidate.entry.id, decision.brief)
      else if (decision.kind !== 'body-below-threshold') pending.push(candidate)
    }
    if (pending.length === 0) return briefs

    // One read per DISTINCT owner scope (at most two in practice: the run's workspace and
    // its account), indexed into a map — never a point read per fragment.
    const stored = await this.loadStored(pending)
    if (!stored) return briefs

    const toGenerate: { candidate: FragmentBriefCandidate; bodyFingerprint: string }[] = []
    for (const candidate of pending) {
      const { ownerKind, ownerId } = candidate.entry.briefScope
      const decision = resolveFragmentBrief({
        body: candidate.body,
        authoredBrief: candidate.entry.brief,
        stored: stored.get(`${scopeKey(ownerKind, ownerId)}|${candidate.entry.id}`) ?? null,
      })
      // `not-condensable` lands here as neither: this exact body was already condensed and
      // the result was unusable, so the full text is folded WITHOUT a second model call.
      if (decision.kind === 'generated') briefs.set(candidate.entry.id, decision.brief)
      else if (decision.kind === 'generate') {
        toGenerate.push({ candidate, bodyFingerprint: decision.bodyFingerprint })
      }
    }

    const generator = this.generator
    if (toGenerate.length === 0 || !generator?.enabled) return briefs

    // Bounded fan-out: only the oversized standards THIS dispatch folds, and only the ones
    // with no record against their CURRENT body — in the steady state, none.
    //
    // Deliberately NOT claim-guarded. Two dispatches racing on the same fresh standard both
    // condense and both upsert, which costs one extra cheap call and converges (same
    // fingerprint, identical row shape). A claim table with a TTL — the shape used for the
    // tracker/review posts — earns its keep against a duplicated EXTERNAL side effect; here
    // the only cost of losing the race is the call itself, which is the thing a claim round
    // trip would also spend.
    const generated = await Promise.all(
      toGenerate.map(({ candidate, bodyFingerprint }) =>
        runBestEffort(
          this.log,
          'fragment brief generation',
          async () => {
            const result = await generator.generate(workspaceId, {
              title: candidate.entry.title,
              body: candidate.body,
              ...(candidate.entry.summary ? { summary: candidate.entry.summary } : {}),
            })
            // Both outcomes are persisted against the body's fingerprint. Recording the
            // refusal is what stops a standard that cannot be usefully shortened — which is
            // an ORDINARY result of a generator told to keep every rule — from re-paying for
            // a model call on every implementer dispatch for the rest of its life. It clears
            // itself: edit the standard and the fingerprint no longer matches.
            const brief = result.outcome === 'brief' ? result.brief : NOT_CONDENSABLE
            const record: FragmentBriefRecord = {
              ownerKind: candidate.entry.briefScope.ownerKind,
              ownerId: candidate.entry.briefScope.ownerId,
              fragmentId: candidate.entry.id,
              bodyFingerprint,
              brief,
              model: result.model,
              generatedAt: this.clock.now(),
            }
            await this.repo.upsert(record)
            if (result.outcome === 'not-condensable') {
              // Not a failure — but silence here reads as "the feature is on" while every
              // implementer keeps getting full bodies, so say which standard and why once.
              this.log.info('fragment brief not condensable; folding the full standard', {
                workspaceId,
                fragmentId: candidate.entry.id,
                reason: result.reason,
                model: result.model,
              })
              return undefined
            }
            return { id: candidate.entry.id, brief: result.brief }
          },
          { workspaceId, fragmentId: candidate.entry.id },
        ),
      ),
    )
    for (const result of generated) {
      if (result) briefs.set(result.id, result.brief)
    }
    return briefs
  }

  /**
   * Drop a fragment's generated brief. Called when the fragment itself is removed so the
   * derived row does not outlive what it condenses; best-effort, because a stale row is
   * inert (the fingerprint would reject it against any body) and losing the delete must
   * never fail the removal a curator asked for.
   */
  async forget(ownerKind: FragmentOwnerKind, ownerId: string, fragmentId: string): Promise<void> {
    await runBestEffort(this.log, 'fragment brief delete', () =>
      this.repo.delete(ownerKind, ownerId, fragmentId),
    )
  }

  /**
   * Every stored brief for the scopes `pending` spans, keyed `scope|fragmentId`. Returns
   * undefined when the store could not be read at all — the caller then folds full bodies
   * rather than treating an outage as "nothing has ever been generated", which would
   * re-condense the whole catalog on every dispatch for as long as the store is down.
   */
  private async loadStored(
    pending: FragmentBriefCandidate[],
  ): Promise<Map<string, StoredFragmentBrief> | undefined> {
    const scopes = new Map<string, { ownerKind: FragmentOwnerKind; ownerId: string }>()
    for (const { entry } of pending) {
      scopes.set(scopeKey(entry.briefScope.ownerKind, entry.briefScope.ownerId), entry.briefScope)
    }
    const rows = await runBestEffort(this.log, 'fragment brief load', () =>
      Promise.all(
        [...scopes.values()].map((scope) => this.repo.listByOwner(scope.ownerKind, scope.ownerId)),
      ),
    )
    if (!rows) return undefined
    const byKey = new Map<string, StoredFragmentBrief>()
    for (const row of rows.flat()) {
      byKey.set(`${scopeKey(row.ownerKind, row.ownerId)}|${row.fragmentId}`, {
        brief: row.brief,
        bodyFingerprint: row.bodyFingerprint,
      })
    }
    return byKey
  }
}
