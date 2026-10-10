import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { involvedServicesSection } from './standard.js'

function ctx(involvedServices?: AgentRunContext['involvedServices']): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(involvedServices ? { involvedServices } : {}),
  }
}

describe('involvedServicesSection', () => {
  it('is empty when the task names no involved services', () => {
    expect(involvedServicesSection(ctx())).toBe('')
    expect(involvedServicesSection(ctx([]))).toBe('')
  })

  it('names each peer, its relationship, and its live environment', () => {
    const out = involvedServicesSection(
      ctx([
        {
          frameId: 'f_email',
          title: 'Email',
          description: 'sends the confirmation mail',
          envUrl: 'https://email-pr8.example',
        },
      ]),
    )
    expect(out).toContain('- Email')
    expect(out).toContain('sends the confirmation mail')
    expect(out).toContain('(live environment: https://email-pr8.example)')
  })

  it('says nothing extra when the peer environment name carried', () => {
    // The ordinary case, and the only silent one: a peer reached by its own name needs no
    // narration, exactly like the run's own environment.
    const out = involvedServicesSection(
      ctx([
        {
          frameId: 'f_email',
          title: 'Email',
          envUrl: 'https://email-pr8.example',
          envReachability: { state: 'reached' },
        },
      ]),
    )
    expect(out).not.toContain('reachable at')
    expect(out).not.toContain('could NOT reach')
  })

  it('carries the address a peer was reached at, when its name did not carry', () => {
    const out = involvedServicesSection(
      ctx([
        {
          frameId: 'f_email',
          title: 'Email',
          envUrl: 'https://email-pr8.example',
          envReachability: { state: 'reached', address: '10.4.19.23' },
        },
      ]),
    )
    expect(out).toContain('reachable at 10.4.19.23, not by hostname')
  })

  it('SAYS a peer could not be reached, instead of listing it as a healthy URL', () => {
    // The case carrying only the address left silent. A peer the platform failed to reach has no
    // address, so it rendered as an ordinary live environment: a cross-service tester then spends
    // its step on connection failures and reports the peer as down, which is byte-for-byte the
    // misdiagnosis this whole mechanism exists to retire, arriving one service over.
    const out = involvedServicesSection(
      ctx([
        {
          frameId: 'f_email',
          title: 'Email',
          envUrl: 'https://email-pr8.example',
          envReachability: { state: 'not_reached', reason: 'name_unresolved' },
        },
      ]),
    )
    expect(out).toContain('could NOT reach this peer: name_unresolved')
    expect(out).toContain('NOT evidence about your own service')
  })

  it('says a peer check was inconclusive rather than implying either verdict', () => {
    const out = involvedServicesSection(
      ctx([
        {
          frameId: 'f_email',
          title: 'Email',
          envUrl: 'https://email-pr8.example',
          envReachability: { state: 'inconclusive', reason: 'probe_failed' },
        },
      ]),
    )
    expect(out).toContain('could not establish whether this peer is reachable')
    expect(out).toContain('unexplained')
  })
})
