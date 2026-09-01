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
    failure: { error: 'Environment was still provisioning after 20 minutes', reason: 'timeout' },
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
      failure: { error: 'boom', reason: 'timeout', waitedMs: 1_200_000 },
    })
    expect(prompt).toContain('boom')
    expect(prompt).toContain('classified the cause as: timeout')
    expect(prompt).toContain('readiness wait ran for 1200 seconds')
  })

  it('says plainly when NOTHING waited, rather than reporting a zero-second wait', () => {
    expect(render()).toContain('Nothing waited on this environment')
  })

  it('says the platform could not classify the cause rather than omitting the line', () => {
    expect(render({ failure: { error: 'boom' } })).toContain('could not classify the cause')
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
