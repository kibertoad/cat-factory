import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_PROBE_API_SYSTEM_PROMPT,
  ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT,
  environmentProbeSystemPrompt,
  environmentProbeUserPrompt,
  type EnvironmentProbeBrief,
} from './environment-probe.js'

// The AGENT DRY RUN's prompts. Two things are asserted rather than the wording:
//
//   - both probers are told to exercise AUTHENTICATION and told that a healthcheck does not
//     count. The platform's verdict refuses `operable` without an authenticated success, so a
//     prompt that dropped either instruction would produce a run that can never earn a clean
//     verdict and an operator who cannot tell why;
//   - every ABSENCE is stated rather than omitted. `missingContext` is the report's product, and
//     a prober that cannot tell "the platform configured no credentials" from "credentials exist
//     and I was not shown them" fills that list with its own ignorance instead.

function brief(over: Partial<EnvironmentProbeBrief> = {}): EnvironmentProbeBrief {
  return {
    surface: 'api',
    service: { title: 'Grass API', description: 'Serves grass to lawns.' },
    environment: { url: 'https://pr-1.acme.test', status: 'ready' },
    testSecrets: { status: 'resolved', refs: [] },
    repo: { owner: 'kibertoad', name: 'acme', branch: 'cat-factory/env-test/x' },
    ...over,
  }
}

describe('the prober system prompts', () => {
  it('picks the prompt for the surface', () => {
    expect(environmentProbeSystemPrompt('api')).toBe(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT)
    expect(environmentProbeSystemPrompt('ui')).toBe(ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT)
  })

  it('requires an authenticated operation and rules a healthcheck out, on BOTH surfaces', () => {
    for (const prompt of [
      ENVIRONMENT_PROBE_API_SYSTEM_PROMPT,
      ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toContain('At least ONE of them MUST go through authentication')
      expect(prompt).toContain('does not count as one of them')
      // The report is the deliverable, so the answer must land in the visible reply.
      expect(prompt).toContain('Your deliverable is the text of your FINAL reply')
      // It judges per operation; the platform grades.
      expect(prompt).toContain('Do not grade the run')
      // Read-only: a dry run must not become a change.
      expect(prompt).toContain('NEVER change the service, the repository or the environment')
    }
  })

  it('gives each surface its own tooling and its own hardest question', () => {
    expect(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT).toContain('over HTTP')
    expect(ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT).toContain('Playwright')
    // Signing in is what a browser prober is FOR: a landing page that renders proves nothing.
    expect(ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT).toContain('Signing in is the operation that matters')
  })
})

describe('environmentProbeUserPrompt', () => {
  it('names the system, the environment and the repository branch', () => {
    const prompt = environmentProbeUserPrompt(brief())
    expect(prompt).toContain('Grass API')
    expect(prompt).toContain('Serves grass to lawns.')
    expect(prompt).toContain('https://pr-1.acme.test')
    expect(prompt).toContain('`kibertoad/acme`')
    expect(prompt).toContain('cat-factory/env-test/x')
  })

  it('STATES an unknown product rather than leaving the agent to supply one', () => {
    const prompt = environmentProbeUserPrompt(brief({ service: { title: 'svc' } }))
    expect(prompt).toContain('No description was recorded')
    expect(prompt).toContain('do not infer a product')
  })

  it('states that NO credentials are configured, and names the finding for it', () => {
    const prompt = environmentProbeUserPrompt(brief())
    expect(prompt).toContain('NONE.')
    expect(prompt).toContain('`auth_missing`')
  })

  it('advertises each configured credential by key and purpose, never by value', () => {
    const prompt = environmentProbeUserPrompt(
      brief({
        testSecrets: {
          status: 'resolved',
          refs: [{ key: 'API_TOKEN', description: 'read-write token for the test tenant' }],
        },
      }),
    )
    expect(prompt).toContain('`API_TOKEN`')
    expect(prompt).toContain('read-write token for the test tenant')
    expect(prompt).toContain('must never appear in your reply')
  })

  it('blames the PLATFORM when the credential store would not open, never the board', () => {
    // The collapse this guards against is silent and points a human at the wrong fix: an operator
    // told "configure credentials for this service" may already have done exactly that, and only
    // the platform's own store failed to open.
    const prompt = environmentProbeUserPrompt(brief({ testSecrets: { status: 'unreadable' } }))
    expect(prompt).toContain('may well have test credentials configured')
    expect(prompt).toContain('Do NOT tell a human to configure credentials for this service')
    expect(prompt).toContain('`auth_missing`')
  })

  it('states a deployment with NO credential store as a deployment fact', () => {
    const prompt = environmentProbeUserPrompt(brief({ testSecrets: { status: 'unwired' } }))
    expect(prompt).toContain('no sealed credential store wired')
    expect(prompt).toContain('rather than asking for this service to be reconfigured')
  })

  it('renders the environment access scheme, including the deliberate `none`', () => {
    const bearer = environmentProbeUserPrompt(
      brief({
        environment: {
          url: 'https://x.test',
          status: 'ready',
          access: { scheme: 'bearer', token: 'tok' },
        },
      }),
    )
    expect(bearer).toContain('Authorization: Bearer tok')

    // `none` is a STATEMENT by the provider that no credential is needed. Skipping it would have
    // the prober report the platform's silence as `auth_missing` on an open environment.
    const open = environmentProbeUserPrompt(
      brief({
        environment: { url: 'https://x.test', status: 'ready', access: { scheme: 'none' } },
      }),
    )
    expect(open).toContain('needs NO credential of its own')

    // An access bag that never arrived is the OPPOSITE fact, and says so.
    const unknown = environmentProbeUserPrompt(brief())
    expect(unknown).toContain('NOT STATED')
  })

  it('says a scheme was declared with no usable credential behind it', () => {
    const prompt = environmentProbeUserPrompt(
      brief({
        environment: { url: 'https://x.test', status: 'ready', access: { scheme: 'bearer' } },
      }),
    )
    expect(prompt).toContain('supplied no usable credential')
    expect(prompt).toContain('`access_unclear`')
  })

  it('says an unreachable environment was the PLATFORM own finding, not the prober tooling', () => {
    const proved = environmentProbeUserPrompt(
      brief({
        environment: {
          url: 'https://x.test',
          status: 'ready',
          reachability: { state: 'not_reached', reason: 'dns' },
        },
      }),
    )
    // The SHARED renderer the tester's environment section uses, so the two cannot disagree.
    expect(proved).toContain('could NOT reach this environment')

    // Nothing probed: the prober is told so explicitly, because that is what decides whether a
    // connection failure is the environment's fault or its own.
    const unproved = environmentProbeUserPrompt(brief())
    expect(unproved).toContain('has not proved a route')
    expect(unproved).toContain('`unreachable`')
  })

  it('states a missing environment URL as a blocker rather than rendering an empty target', () => {
    const prompt = environmentProbeUserPrompt(
      brief({ environment: { url: null, status: 'ready' } }),
    )
    expect(prompt).toContain('NOT STATED')
    expect(prompt).toContain('nothing for you to drive')
  })

  it('scopes a monorepo service to its own subdirectory', () => {
    const prompt = environmentProbeUserPrompt(
      brief({
        repo: {
          owner: 'kibertoad',
          name: 'acme',
          branch: 'b',
          serviceDirectory: 'services/grass',
        },
      }),
    )
    expect(prompt).toContain('`services/grass`')
  })
})
