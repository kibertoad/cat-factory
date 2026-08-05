import { afterEach, describe, expect, it } from 'vitest'
import type { AgentKind } from '~/types/domain'
import {
  COMPANION_FOR_PRODUCER,
  __resetCustomCompanionTargetsForTest,
  companionForProducer,
  isProducerCompanion,
  setCustomCompanionTargets,
} from '~/utils/catalog'

// The SPA half of the companion registry. A companion is not a placeable palette block: the
// builder renders it as an "add companion" toggle ON its producer and inserts it immediately
// after. These two lookups are what decide that, so a deployment's registered pair is either
// visible as a toggle or invisible entirely, with nothing in between.
//
// The backend half is `extension-registries.companions.test.ts`. Both are needed: the backend
// enforces the adjacency rule on save, and this decides whether a person can ever express the
// pairing in the first place.

afterEach(() => {
  __resetCustomCompanionTargetsForTest()
})

describe('custom companion pairings in the palette', () => {
  it('has no opinion about a deployment’s pair until the store projects it', () => {
    // The pre-registration state is a real one: the snapshot arrives after first paint, and a
    // custom companion must degrade to an ordinary kind rather than to a broken toggle.
    expect(isProducerCompanion('acme:migration-auditor')).toBe(false)
    expect(companionForProducer('acme:migrator')).toBeUndefined()
  })

  it('renders a registered pair as a toggle on its producer', () => {
    setCustomCompanionTargets({ 'acme:migration-auditor': ['acme:migrator'] })
    expect(companionForProducer('acme:migrator')).toBe('acme:migration-auditor')
    // ...and the companion itself leaves the palette, which is the other half of "it is a
    // toggle, not a block". Registering only one of these would show the kind twice.
    expect(isProducerCompanion('acme:migration-auditor')).toBe(true)
    // The producer is not a companion just for being reviewed by one.
    expect(isProducerCompanion('acme:migrator')).toBe(false)
  })

  it('lets one companion review several producers', () => {
    setCustomCompanionTargets({ 'acme:auditor': ['acme:migrator', 'acme:packager'] })
    expect(companionForProducer('acme:migrator')).toBe('acme:auditor')
    expect(companionForProducer('acme:packager')).toBe('acme:auditor')
  })

  it('never lets a deployment re-point a BUILT-IN producer at its own companion', () => {
    // Built-ins win, matching `agentKindMeta`'s precedence and the backend registry's refusal to
    // shadow a built-in kind. The shipped pairing is what every stock pipeline relies on, so a
    // silent re-point would change what those pipelines do without anyone editing them.
    setCustomCompanionTargets({ 'acme:reviewer': ['coder'] })
    expect(companionForProducer('coder')).toBe(COMPANION_FOR_PRODUCER.coder)
    // The custom kind still leaves the palette: it IS a companion, it just does not get `coder`.
    expect(isProducerCompanion('acme:reviewer')).toBe(true)
  })

  it('resolves a contested producer deterministically, first registration winning', () => {
    // Only one toggle can hang off a producer, so two companions claiming it is a case with an
    // answer whether or not anyone chose one. Pinning it here is what keeps the answer from
    // being "whichever the object happened to enumerate first".
    const contested: Record<string, readonly AgentKind[]> = {
      'acme:first': ['acme:migrator'],
      'acme:second': ['acme:migrator'],
    }
    setCustomCompanionTargets(contested)
    expect(companionForProducer('acme:migrator')).toBe('acme:first')
    expect(isProducerCompanion('acme:second')).toBe(true)
  })

  it('drops a pairing when the catalog it came from goes away', () => {
    setCustomCompanionTargets({ 'acme:migration-auditor': ['acme:migrator'] })
    expect(companionForProducer('acme:migrator')).toBe('acme:migration-auditor')
    // A workspace switch re-projects an empty catalog. The lookups must follow it rather than
    // keep answering from the old deployment's registrations.
    setCustomCompanionTargets({})
    expect(companionForProducer('acme:migrator')).toBeUndefined()
    expect(isProducerCompanion('acme:migration-auditor')).toBe(false)
  })
})
