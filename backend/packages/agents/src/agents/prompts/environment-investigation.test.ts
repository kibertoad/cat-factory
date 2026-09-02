import { describe, expect, it } from 'vitest'
import type { Block, EnvironmentEvidenceBundle } from '@cat-factory/kernel'
import { renderEnvironmentInvestigationPrompt } from './environment-investigation.js'

// The prompt's job is to make the bundle's ABSENCES visible. A section quietly omitted reads
// exactly like a section that came back clean, and an investigator reasoning from that silence
// reaches the confident wrong answer this whole feature exists to replace.

const block = { id: 'task_1', title: 'Add catalog search' } as Block

function bundle(overrides: Partial<EnvironmentEvidenceBundle> = {}): EnvironmentEvidenceBundle {
  return {
    environment: {
      id: 'env_1',
      status: 'ready',
      url: 'https://pr-42.example.test',
      expiresAt: null,
      lastError: null,
      provisionType: 'preview',
      engine: 'remote-custom',
    },
    provisionFields: {},
    timeline: [],
    route: { candidates: [], proof: null },
    failure: {
      error: 'Environment was still provisioning after 20 minutes',
      reason: 'timeout',
      readinessWait: 'verdict_without_wait',
    },
    ...overrides,
  }
}

function render(overrides: Partial<EnvironmentEvidenceBundle> = {}, offered = ['stop', 'wait']) {
  return renderEnvironmentInvestigationPrompt({
    workspaceId: 'ws_1',
    executionId: 'exec_1',
    block,
    evidence: bundle(overrides),
    offeredActions: offered,
  })
}

describe('renderEnvironmentInvestigationPrompt', () => {
  it("leads with the run's failure, its classification and how long anything waited", () => {
    const prompt = render({
      failure: {
        error: 'boom',
        reason: 'timeout',
        readinessWait: 'waited',
        waitedMs: 1_200_000,
      },
    })
    expect(prompt).toContain('boom')
    expect(prompt).toContain('classified the cause as: timeout')
    expect(prompt).toContain('readiness wait ran for 1200 seconds')
  })

  it('says plainly when NOTHING waited, rather than reporting a zero-second wait', () => {
    expect(render()).toContain('Nothing waited on this environment')
  })

  it('refuses to claim a live verdict for a failure that never reached one', () => {
    // The three readiness stories are distinct facts. A deploy container shut down mid-run has no
    // readiness verdict AND no wait, and reporting it as "there was a live verdict and nothing
    // waited" is a claim, made directly above the directive telling the model to line the
    // timestamps up.
    const prompt = render({
      failure: { error: 'the deploy container was stopped', readinessWait: 'not_reached' },
    })
    expect(prompt).toContain('BEFORE any readiness judgement')
    expect(prompt).not.toContain('Nothing waited on this environment')
  })

  it('says the platform could not classify the cause rather than omitting the line', () => {
    expect(render({ failure: { error: 'boom', readinessWait: 'not_reached' } })).toContain(
      'could not classify the cause',
    )
  })

  it('states what the PLATFORM held back, apart from what the provider could not read', () => {
    const prompt = render({
      evidenceCaps: ['The provider reported 400 facts; only the first 120 are below.'],
    })
    expect(prompt).toContain('What the platform did NOT pass on')
    expect(prompt).toContain('only the first 120 are below')
    expect(prompt).toContain('held back by the platform for size, not refused by the provider')
  })

  it('renders the whole provision-field bag, sorted', () => {
    const prompt = render({
      provisionFields: { urlHostResolves: 'false', kargoBalancers: '[]', namespace: 'pr-42' },
    })
    const body = prompt.slice(prompt.indexOf('Provision fields'))
    expect(body.indexOf('kargoBalancers')).toBeLessThan(body.indexOf('namespace'))
    expect(body.indexOf('namespace')).toBeLessThan(body.indexOf('urlHostResolves'))
  })

  it('calls an empty provision-field bag an ABSENCE rather than dropping the section', () => {
    const prompt = render()
    expect(prompt).toContain('Provision fields captured from the provider')
    expect(prompt).toContain('This is an ABSENCE, not a clean result')
  })

  it('states the addresses there were to dial, and calls an empty list what it is', () => {
    // Issue #2163's third half. `no address was captured at all` was the entire cause of the
    // motivating failure and the investigation found it, as one bullet subordinated to a headline
    // blaming a platform gate that had worked. So the platform COMPUTES the determinate cause and
    // says it ranks first, rather than asking the model to rank it.
    const prompt = render({
      route: {
        candidates: [],
        proof: {
          state: 'not_reached',
          via: null,
          reason: 'name_unresolved',
          attempts: [{ target: 'pr-42.example.test:443', outcome: 'name_unresolved' }],
          checkedAt: 1_788_347_753_453,
        },
      },
    })
    expect(prompt).toContain('Reaching this environment')
    expect(prompt).toContain('addresses the provider stated for this environment')
    expect(prompt).toContain('2026-09-02T11:15:53.453Z')
    expect(prompt).toContain('A DETERMINATE CAUSE the platform already computed')
    expect(prompt).toContain('the provider stated no addresses for it')
    expect(prompt).toContain('make it the headline')
  })

  it('offers no determinate cause when the evidence does not settle one', () => {
    // `inconclusive` is an admission about the PLATFORM, and dressing it as a determinate cause is
    // how "we could not tell" comes to read as a verdict about the environment.
    const prompt = render({
      route: {
        candidates: [{ address: '10.4.19.22', label: 'internal ALB' }],
        proof: {
          state: 'inconclusive',
          via: null,
          reason: 'probe_failed',
          attempts: [],
          checkedAt: 1_788_347_753_453,
        },
      },
    })
    expect(prompt).toContain('10.4.19.22 (internal ALB)')
    expect(prompt).not.toContain('A DETERMINATE CAUSE')
  })

  it('calls an unprobed route an absence of a check, never a passed one', () => {
    expect(render()).toContain('That is an ABSENCE of a check, never a passed one')
  })

  it('refuses to let an empty timeline read as a quiet run', () => {
    expect(render()).toContain('draw no conclusion from the silence')
  })

  it("renders the provider's facts with its own verdict on each, undecided included", () => {
    const prompt = render({
      diagnosis: {
        facts: [
          { key: 'environment.status', value: 'online' },
          { key: 'jobs[0].vm.status', value: 'offline', healthy: false },
        ],
      },
    })
    // The contradiction is the finding; both halves have to be visible for it to be one.
    expect(prompt).toContain('environment.status = online (provider offers no verdict)')
    expect(prompt).toContain('jobs[0].vm.status = offline (provider considers this UNHEALTHY)')
  })

  it('marks a truncated log as a TAIL so the missing start is not read as unlogged', () => {
    const prompt = render({
      diagnosis: { facts: [], logs: [{ source: 'pod/api', text: 'boom', truncated: true }] },
    })
    expect(prompt).toContain('TAIL only')
  })

  it('states every read the provider could not make, and which will never answer', () => {
    const prompt = render({
      diagnosis: {
        facts: [],
        gaps: [
          { read: 'pod logs', reason: 'the ServiceAccount holds no grant', permanent: true },
          { read: 'events', reason: 'apiserver timed out' },
        ],
      },
    })
    expect(prompt).toContain('treat each as UNKNOWN, never as healthy')
    expect(prompt).toContain('this will never answer differently')
    expect(prompt).toContain('apiserver timed out')
  })

  it('states why there is no provider account at all', () => {
    const prompt = render({ diagnosisUnavailable: 'This provider implements no diagnostics.' })
    expect(prompt).toContain("The provider's own account is unavailable")
    expect(prompt).toContain('This provider implements no diagnostics.')
  })

  it('names exactly the actions the engine will honour this round', () => {
    const prompt = render({}, ['stop', 'reprovision'])
    expect(prompt).toContain('stop, reprovision')
    expect(prompt).toContain('Anything else is discarded and read as "stop"')
  })
})
