import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import {
  deliverableIsReply,
  dispatchDeliversCheckout,
  runsInContainer,
} from './container-surface.js'

/** The registry every facade builds: the built-in kinds pre-loaded, nothing deployment-specific. */
const registry = () => defaultAgentKindRegistry()

describe('runsInContainer', () => {
  it('covers the built-in checkout kinds', () => {
    for (const kind of ['coder', 'ci-fixer', 'merger', 'tester-api', 'analysis', 'architect']) {
      expect(runsInContainer(kind, registry())).toBe(true)
    }
  })

  it('covers a container-backed COMPANION, which is a pairing rather than a kind', () => {
    // `reviewer` is registered as a `container-explore` COMPANION, never as an agent kind — the
    // predicate must reach it through the companion catalog.
    expect(registry().get('reviewer')).toBeUndefined()
    expect(runsInContainer('reviewer', registry())).toBe(true)
  })

  it('covers `pr-reviewer` through its REGISTERED container surface', () => {
    expect(runsInContainer('pr-reviewer', registry())).toBe(true)
  })

  it('covers a registered custom kind that declared a container surface', () => {
    const reg = registry()
    reg.register({
      kind: 'org-auditor',
      systemPrompt: 'x',
      agent: { surface: 'container-explore' },
    })
    expect(runsInContainer('org-auditor', reg)).toBe(true)
  })

  it('reads every built-in container kind off its own registration, with no allow-list left', () => {
    // The property the strangler bought: a container kind is one that DECLARED a container
    // surface. Derived from the registry rather than re-listed, so a kind added to the catalog
    // cannot be missed here (which is exactly what the deleted hard-coded Set made possible).
    const declared = registry()
      .all()
      .filter((definition) => definition.agent?.surface?.startsWith('container-'))
    expect(declared.length).toBeGreaterThan(0)
    for (const definition of declared) {
      expect(runsInContainer(definition.kind, registry())).toBe(true)
    }
  })

  it('is false for a genuinely inline kind', () => {
    expect(runsInContainer('spec-companion', registry())).toBe(false)
  })
})

describe('dispatchDeliversCheckout', () => {
  it('follows the kind when consensus is not running', () => {
    expect(dispatchDeliversCheckout('pr-reviewer', registry())).toBe(true)
    expect(dispatchDeliversCheckout('pr-reviewer', registry(), { consensusEnabled: false })).toBe(
      true,
    )
  })

  it('is FALSE for a consensus dispatch even of a container kind — the panel runs inline', () => {
    expect(dispatchDeliversCheckout('pr-reviewer', registry(), { consensusEnabled: true })).toBe(
      false,
    )
    expect(dispatchDeliversCheckout('architect', registry(), { consensusEnabled: true })).toBe(
      false,
    )
  })

  it('leans at the recoverable error', () => {
    // The executor may still fall through to the standard CONTAINER agent for a consensus-enabled
    // step (an ineligible kind, <2 participants, an un-cleared gate). Predicting "no checkout"
    // then merely hands a container agent an inlined diff it did not need; predicting the other
    // way hands an inline panel a manifest telling it to run git. Only the first is recoverable,
    // so an ineligible-for-consensus container kind still reports false while consensus is on.
    expect(dispatchDeliversCheckout('coder', registry(), { consensusEnabled: true })).toBe(false)
  })
})

describe('deliverableIsReply', () => {
  it('is TRUE for the kinds whose product is their answer', () => {
    // An explore returns a report or structured JSON the platform parses (`spec-writer` hands its
    // whole tree back that way), and an inline kind has nowhere else to put anything.
    for (const kind of ['architect', 'analysis', 'spec-writer', 'pr-reviewer']) {
      expect(deliverableIsReply(kind, registry())).toBe(true)
    }
  })

  it('is FALSE for a kind that PUSHES its work', () => {
    // The whole reason the rule exists: a `container-coding` kind's deliverable is the commit, and
    // CLAUDE.md has it ending with no final text at all, so its reply proves nothing either way.
    for (const kind of ['coder', 'ci-fixer', 'doc-writer']) {
      expect(deliverableIsReply(kind, registry())).toBe(false)
    }
  })

  it('agrees with the surface every registered kind declares, built-in or not', () => {
    // Derived from the registry rather than re-listed, so a kind added to the catalog cannot drift
    // away from this answer, and a deployment's own kind gets it from its own declaration.
    const reg = registry()
    reg.register({
      kind: 'org-auditor',
      systemPrompt: 'x',
      agent: { surface: 'container-explore' },
    })
    reg.register({ kind: 'org-fixer', systemPrompt: 'x', agent: { surface: 'container-coding' } })
    for (const definition of reg.all()) {
      const surface = definition.agent?.surface
      if (!surface) continue
      expect(deliverableIsReply(definition.kind, reg)).toBe(surface !== 'container-coding')
    }
  })

  it('is FALSE for a kind that declared no surface at all', () => {
    // Fail-safe, and the direction matters: the callers treat `true` as licence to conclude
    // something from a step's `output`, so a kind that said nothing must license nothing. (A
    // container-backed COMPANION is registered as a pairing, not as an agent kind, which is why
    // `runsInContainer` has to consult the companion catalog and this deliberately does not: what
    // is being asked about here is always a PRODUCER step.)
    const reg = registry()
    reg.register({ kind: 'org-plain', systemPrompt: 'x' })
    expect(deliverableIsReply('org-plain', reg)).toBe(false)
    expect(deliverableIsReply('not-a-kind-at-all', reg)).toBe(false)
  })
})
