import { DEFAULT_TUTORIAL_PROGRESS } from '@cat-factory/contracts'
import type { TutorialProgress, UpdateTutorialProgressInput } from '@cat-factory/contracts'
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
   * from a laptop because the desktop wrote an older list. A union has no such ordering
   * requirement, needs no revision guard, and makes the write idempotent under the retries a
   * fire-and-forget mirror inevitably does.
   *
   * `decision` is the exception and takes the incoming value: it is a preference someone re-answers
   * rather than an accumulating fact, so the newest answer is the right one. (An absent `decision`
   * leaves the stored one alone; only an explicit `null` clears it, which is what a reset does.)
   */
  async merge(userId: string, input: UpdateTutorialProgressInput): Promise<TutorialProgress> {
    const current = await this.get(userId)
    const next: TutorialProgress = {
      decision: 'decision' in input ? (input.decision ?? null) : current.decision,
      completedTourIds: union(current.completedTourIds, input.completedTourIds),
      nudgedTourIds: union(current.nudgedTourIds, input.nudgedTourIds),
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
