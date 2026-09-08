import type { AgentRunContext, TestCredentialBrief } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { SERVICE_DISCOVERY_GUIDANCE } from './environment-under-test.js'
import {
  ENVIRONMENT_PROBE_API_SYSTEM_PROMPT,
  environmentProbeUserPrompt,
} from './environment-probe.js'
import { testSecretsSection } from './standard.js'
import { testingSystemPrompt } from './testing.js'

// ---------------------------------------------------------------------------
// The dry run's ONE claim: a prober that could operate this environment predicts that the tester
// step will be able to. That claim rests entirely on the two being told the same things, and
// nothing about the code shape enforces it: both sides render prose, and prose drifts silently in
// the direction of whichever one someone last edited. These are the assertions the type checker
// structurally cannot make.
// ---------------------------------------------------------------------------

function testerContext(testSecrets: TestCredentialBrief): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    testSecrets,
  }
}

function proberPrompt(testSecrets: TestCredentialBrief): string {
  return environmentProbeUserPrompt({
    surface: 'api',
    service: { title: 'Grass API' },
    environment: { url: 'https://env.example.com', status: 'ready' },
    testSecrets,
    repo: { owner: 'acme', name: 'grass', branch: 'envtest/1' },
  })
}

describe('what the tester step and the environment dry run are told', () => {
  it('sends both looking for how to operate the service in the same places', () => {
    // Derived from the constant rather than re-spelled, so this cannot be satisfied by a copy that
    // has since diverged from the text either prompt actually carries.
    expect(testingSystemPrompt('tester-api')).toContain(SERVICE_DISCOVERY_GUIDANCE)
    expect(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT).toContain(SERVICE_DISCOVERY_GUIDANCE)
  })

  // One case per credential state, asserted on BOTH sides: a state only one of them keeps is a
  // state the dry run either cannot predict or predicts about a prompt nobody gets.
  const states: { brief: TestCredentialBrief; label: string; shared: string }[] = [
    {
      label: 'a store that would not open',
      brief: { status: 'unreadable' },
      shared: 'THE PLATFORM IS AT FAULT',
    },
    {
      label: 'a deployment with no credential store',
      brief: { status: 'unwired' },
      shared: 'NONE ARE POSSIBLE HERE',
    },
    {
      label: 'a service with none configured',
      brief: { status: 'resolved', refs: [] },
      shared: 'no test credentials configured on the board',
    },
    {
      label: 'a configured credential',
      brief: { status: 'resolved', refs: [{ key: 'API_TOKEN', description: 'service token' }] },
      shared: '`API_TOKEN`: service token',
    },
  ]

  for (const state of states) {
    it(`states ${state.label} to the tester and to the prober alike`, () => {
      expect(testSecretsSection(testerContext(state.brief))).toContain(state.shared)
      expect(proberPrompt(state.brief)).toContain(state.shared)
    })
  }

  it('never puts a credential VALUE in either prompt', () => {
    const brief: TestCredentialBrief = {
      status: 'resolved',
      refs: [{ key: 'API_TOKEN', description: 'service token' }],
    }
    // The brief structurally carries no value; this pins that neither renderer invents a place
    // for one, since both prompts are recorded in telemetry.
    expect(testSecretsSection(testerContext(brief))).toContain('must never appear in your reply')
    expect(proberPrompt(brief)).toContain('must never appear in your reply')
  })
})
