import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { dispatchDeliversCheckout, runsInContainer } from './container-surface.js'

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
