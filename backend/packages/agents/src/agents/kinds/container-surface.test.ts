import { describe, expect, it } from 'vitest'
import { AgentKindRegistry } from './registry.js'
import { PR_REVIEWER_AGENT_KINDS } from './pr-reviewer.js'
import {
  CONTAINER_AGENT_KINDS,
  dispatchDeliversCheckout,
  runsInContainer,
} from './container-surface.js'

/** A registry carrying the built-in `pr-reviewer` definition, as every facade's does. */
const registry = () => {
  const reg = new AgentKindRegistry()
  for (const definition of PR_REVIEWER_AGENT_KINDS) reg.register(definition)
  return reg
}

describe('runsInContainer', () => {
  it('covers the built-in checkout kinds', () => {
    for (const kind of ['coder', 'ci-fixer', 'merger', 'tester-api', 'analysis', 'architect']) {
      expect(runsInContainer(kind, registry())).toBe(true)
    }
  })

  it('covers a container-backed COMPANION without a hard-coded entry', () => {
    // `reviewer` is a `container-explore` companion, not a CONTAINER_AGENT_KINDS member — the
    // predicate must reach it through the companion catalog.
    expect(CONTAINER_AGENT_KINDS.has('reviewer')).toBe(false)
    expect(runsInContainer('reviewer', registry())).toBe(true)
  })

  it('covers `pr-reviewer` through its REGISTERED container surface', () => {
    expect(CONTAINER_AGENT_KINDS.has('pr-reviewer')).toBe(false)
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
