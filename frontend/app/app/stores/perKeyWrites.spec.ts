import { describe, it, expect } from 'vitest'
import { computed } from 'vue'
import type { BrainstormSession } from '~/types/brainstorm'
import type { ClarityReview } from '~/types/clarity'
import type { ConsensusSession } from '~/types/consensus'
import type { DocInterviewSession, Initiative } from '~/types/domain'
import type { RequirementReview } from '~/types/requirements'
import { useBrainstormStore } from '~/stores/brainstorm'
import { useClarityStore } from '~/stores/clarity'
import { useConsensusStore } from '~/stores/consensus'
import { useDocInterviewStore } from '~/stores/docInterview'
import { useInitiativesStore } from '~/stores/initiative'
import { useRequirementsStore } from '~/stores/requirements'

// The review-family stores all hold a `Record<blockId, T>` in a DEEP reactive ref and all patch it
// from a live stream event. `x.value = { ...x.value, [id]: v }` is a write to the REF, a dependency
// every reader shares whatever key it reads, so one event woke every card on the board;
// `x.value[id] = v` keeps the invalidation on the key that changed. The rule is stated once in
// `frontend/app/README.md` ("A record keyed by block id is written PER KEY, never replaced").
//
// One table rather than six near-identical specs, because the property is one property and a store
// that JOINS this family should have exactly one obvious place to be added. Each row asserts the
// two halves that can regress independently: an event for another block does not invalidate this
// block's reader, and a FIRST write still reaches a reader that read the key while it was absent
// (Vue tracks a missing-key read, which is what makes the in-place write safe at all).

interface StoreCase {
  name: string
  /** Patch the store from a live event for `blockId`, tagged with `mark` so the read can see it. */
  write: (blockId: string, mark: string) => void
  /** What a card renders off that block: the tag, or null when the store holds nothing. */
  read: (blockId: string) => string | null
}

const cases: StoreCase[] = [
  {
    name: 'requirements',
    write: (blockId, mark) => {
      useRequirementsStore().upsert({
        id: mark,
        blockId,
        status: 'ready',
        iteration: 1,
        maxIterations: 3,
        items: [],
        updatedAt: 1,
      } as unknown as RequirementReview)
    },
    read: (blockId) => useRequirementsStore().reviewFor(blockId)?.id ?? null,
  },
  {
    name: 'clarity',
    write: (blockId, mark) => {
      useClarityStore().upsert({
        id: mark,
        blockId,
        status: 'ready',
        items: [],
        updatedAt: 1,
      } as unknown as ClarityReview)
    },
    read: (blockId) => useClarityStore().reviewFor(blockId)?.id ?? null,
  },
  {
    name: 'brainstorm',
    // Keyed by block+STAGE, so a block legitimately holds one live session per stage; the
    // invalidation still has to land on the one composite key that changed.
    write: (blockId, mark) => {
      useBrainstormStore().upsert({
        id: mark,
        blockId,
        stage: 'requirements',
        status: 'ready',
        options: [],
        updatedAt: 1,
      } as unknown as BrainstormSession)
    },
    read: (blockId) => useBrainstormStore().sessionFor(blockId, 'requirements')?.id ?? null,
  },
  {
    name: 'consensus',
    write: (blockId, mark) => {
      useConsensusStore().upsert({
        id: mark,
        blockId,
        status: 'complete',
        participants: [],
        rounds: [],
        synthesis: null,
        createdAt: 1,
        updatedAt: 1,
      } as unknown as ConsensusSession)
    },
    read: (blockId) => useConsensusStore().sessionFor(blockId)?.id ?? null,
  },
  {
    name: 'docInterview',
    write: (blockId, mark) => {
      useDocInterviewStore().upsert({
        id: mark,
        blockId,
        status: 'awaiting_answers',
        round: 1,
        maxRounds: 3,
        qa: [],
        createdAt: 1,
        updatedAt: 1,
      } as unknown as DocInterviewSession)
    },
    read: (blockId) => useDocInterviewStore().forBlock(blockId)?.id ?? null,
  },
  {
    name: 'initiative',
    write: (blockId, mark) => {
      useInitiativesStore().upsert({
        id: mark,
        blockId,
        slug: 'i',
        title: 'I',
        rev: 1,
      } as unknown as Initiative)
    },
    read: (blockId) => useInitiativesStore().forBlock(blockId)?.id ?? null,
  },
]

describe.each(cases)('$name store per-key writes', ({ write, read }) => {
  it('an event for one block does not invalidate a consumer reading another', () => {
    write('blk-a', 'a1')

    let evaluations = 0
    const forA = computed(() => {
      evaluations++
      return read('blk-a')
    })
    expect(forA.value).toBe('a1')
    expect(evaluations).toBe(1)

    // A brand-new key, then a rewrite of that existing one: neither is about `blk-a`.
    write('blk-b', 'b1')
    expect(forA.value).toBe('a1')
    write('blk-b', 'b2')
    expect(forA.value).toBe('a1')
    expect(evaluations).toBe(1)

    // The block's OWN event still reaches it.
    write('blk-a', 'a2')
    expect(forA.value).toBe('a2')
    expect(evaluations).toBe(2)
  })

  it('a FIRST write reaches a reader that read the key while it was absent', () => {
    // The half an in-place write could plausibly lose: the reader tracked a key that did not
    // exist. Vue tracks a missing-key read, so ADDING the key notifies it. Without this the
    // window a card opens before its first event would render its empty state forever.
    let evaluations = 0
    const forC = computed(() => {
      evaluations++
      return read('blk-c')
    })
    expect(forC.value).toBeNull()
    expect(evaluations).toBe(1)

    write('blk-c', 'c1')
    expect(forC.value).toBe('c1')
    expect(evaluations).toBe(2)
  })
})
