import { DEFAULT_TUTORIAL_PROGRESS, MAX_TUTORIAL_TOUR_IDS } from '@cat-factory/contracts'
import type { TutorialProgress, UpdateTutorialProgressInput } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import type { TutorialProgressRepository } from '@cat-factory/kernel'

export interface TutorialProgressServiceDependencies {
  tutorialProgressRepository: TutorialProgressRepository
}

/**
 * Union of two id lists, order-preserving and deduplicated: the existing ids keep their order and
 * anything new is appended.
 *
 * Extracted rather than inlined twice because getting it wrong in one of the two sets would be
 * invisible: both are grow-only sets, so a `replace` bug shows up only as a completion quietly
 * disappearing, on a second device, some time later.
 */
function union(existing: readonly string[], incoming: readonly string[] | undefined): string[] {
  if (incoming === undefined) return [...existing]
  const seen = new Set(existing)
  const merged = [...existing]
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id)
      merged.push(id)
    }
  }
  return merged
}

/**
 * Refuse a merge whose RESULT would exceed the per-list ceiling.
 *
 * The wire schema bounds each REQUEST at {@link MAX_TUTORIAL_TOUR_IDS}, which bounds nothing about
 * the stored row: a union of capped requests is uncapped, so N writes of N distinct ids grow the
 * row without limit. That row is not cheap to grow, either — it rides EVERY workspace snapshot for
 * this user, so it is paid on every board load, not just on the write.
 *
 * Refused rather than truncated, matching the schema's own promise. A real catalog is a few dozen
 * ids, so a merge that crosses this is a client bug or abuse, and silently dropping the tail would
 * make the first look like the second's absence.
 */
function assertWithinCap(field: 'completedTourIds' | 'nudgedTourIds', merged: string[]): void {
  if (merged.length > MAX_TUTORIAL_TOUR_IDS) {
    throw new ValidationError(`Too many tutorial tour ids in ${field}`, {
      reason: 'tutorial_progress_too_large',
      field,
      limit: MAX_TUTORIAL_TOUR_IDS,
      merged: merged.length,
    })
  }
}

/**
 * Per-user tutorial progress: what the SPA's browser-persisted store mirrors to, so a person's
 * walkthrough history follows them rather than their browser profile.
 *
 * Reads fall back to the defaults when a user has never saved a row, exactly like the sibling
 * `UserSettingsService`. Writes are where the two differ, and the difference is the whole point.
 */
export class TutorialProgressService {
  constructor(private readonly deps: TutorialProgressServiceDependencies) {}

  async get(userId: string): Promise<TutorialProgress> {
    return (await this.deps.tutorialProgressRepository.get(userId)) ?? DEFAULT_TUTORIAL_PROGRESS
  }

  /**
   * MERGE, never replace, and that is this service's only real design decision.
   *
   * Both id lists are grow-only sets: finishing a walkthrough and spending a contextual offer are
   * facts that happened, and no client is ever right to un-say one. Two browsers signed in as the
   * same person both hold a full local copy and both write it back, so a last-writer-wins replace
   * silently drops whatever the other one had learned since they diverged — a completion vanishing
   * from a laptop because the desktop wrote an older list.
   *
   * `decision` is the exception and takes the incoming value: it is a preference someone re-answers
   * rather than an accumulating fact, so the newest answer is the right one. (An absent `decision`
   * leaves the stored one alone; only an explicit `null` clears it, which is what a reset does.)
   *
   * **Why this load-apply-store is not rev-guarded, unlike every other one-JSON-blob row in the
   * codebase** (the iterative-review stores carry a `rev` and a `compareAndSwap`). That rule is
   * about rows where the row IS the data, and a lost update is therefore data LOSS. This row is a
   * MIRROR: the browser-persisted store is authoritative, the SPA reads it and not this, and every
   * push carries the client's whole local state rather than a delta. So two concurrent merges can
   * still lose one writer's ids — a union is idempotent under RETRY, which is not the same as
   * commutative under CONCURRENCY, and it would be wrong to claim otherwise — but the loss is
   * repaired rather than permanent, because the RESPONSE is the merged row and the client
   * reconciles against it, re-pushing when the answer is missing something it holds
   * (`useTutorialServer.push`). That closure is what makes the missing guard a considered
   * trade rather than the bug the rule exists to prevent; without it "the next write will fix it"
   * would be a hope about a write that may never come.
   */
  async merge(userId: string, input: UpdateTutorialProgressInput): Promise<TutorialProgress> {
    const current = await this.get(userId)
    const completedTourIds = union(current.completedTourIds, input.completedTourIds)
    const nudgedTourIds = union(current.nudgedTourIds, input.nudgedTourIds)
    assertWithinCap('completedTourIds', completedTourIds)
    assertWithinCap('nudgedTourIds', nudgedTourIds)
    const next: TutorialProgress = {
      decision: 'decision' in input ? (input.decision ?? null) : current.decision,
      completedTourIds,
      nudgedTourIds,
    }
    await this.deps.tutorialProgressRepository.upsert(userId, next)
    return next
  }

  /**
   * Forget everything: the "Reset progress" action, whose whole purpose is to restore the
   * first-launch experience. Returns the defaults, so a caller renders the same state a user who
   * has never touched the tutorial sees.
   */
  async reset(userId: string): Promise<TutorialProgress> {
    await this.deps.tutorialProgressRepository.remove(userId)
    return DEFAULT_TUTORIAL_PROGRESS
  }
}
