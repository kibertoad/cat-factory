import type { AgentRunContext, TestCredentialBrief } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CREDENTIAL_GAP_GUIDANCE,
  IMPLEMENTER_CREDENTIAL_GAP_GUIDANCE,
  SERVICE_DISCOVERY_GUIDANCE,
} from './environment-under-test.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import {
  ENVIRONMENT_PROBE_API_SYSTEM_PROMPT,
  ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT,
  environmentProbeUserPrompt,
} from './environment-probe.js'
import { FALSE_SUCCESS_SHAPES } from './shared.js'
import { environmentSection, testSecretsSection } from './standard.js'
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

  it('holds both roles to the same shapes of a success nobody observed', () => {
    // The rule the two had HALVES of: the prober named the HTTP shapes, the tester had the
    // principle and no shapes, in the role where a false pass is what lets a change merge. All
    // four prompts, because a surface is only covered where its own kind carries it.
    expect(testingSystemPrompt('tester-api')).toContain(FALSE_SUCCESS_SHAPES)
    expect(testingSystemPrompt('tester-ui')).toContain(FALSE_SUCCESS_SHAPES)
    expect(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT).toContain(FALSE_SUCCESS_SHAPES)
    expect(ENVIRONMENT_PROBE_UI_SYSTEM_PROMPT).toContain(FALSE_SUCCESS_SHAPES)
  })

  // Each role keeps the STATUS WORD its own report shape uses, which is the line between sharing
  // a rule and merging two roles: the prober reports per-operation outcomes for the platform to
  // conclude from, the tester rules on the change itself.
  it('leaves each role its own verdict vocabulary', () => {
    expect(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT).toContain('`succeeded`')
    expect(ENVIRONMENT_PROBE_API_SYSTEM_PROMPT).toContain('Do not grade the run')
    expect(testingSystemPrompt('tester-api')).toContain('`passed`')
    expect(testingSystemPrompt('tester-api')).toContain('greenlight')
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

// The environment section is NOT a tester's: it rides every prompt a live environment reaches,
// including the implementers, whose product is a pushed commit. The FACTS it states are the same
// for all of them; only where a gap can be RECORDED differs, and getting that wrong tells a coder
// to stop and file a report it does not write.
describe('the environment section across the kinds it reaches', () => {
  const REGISTRY = defaultAgentKindRegistry()
  const withGap = (agentKind: string) =>
    environmentSection(
      {
        ...testerContext({ status: 'resolved', refs: [] }),
        agentKind,
        // A bearer scheme with nothing behind it: the gap case whose remedy the guidance words.
        environment: {
          url: 'https://env.example.com',
          status: 'ready',
          access: { scheme: 'bearer' },
          expiresAt: null,
        },
      },
      REGISTRY,
    )

  it('states the same FACT to a reporter and to an implementer', () => {
    for (const kind of ['tester-api', 'coder']) {
      expect(withGap(kind)).toContain('PLATFORM is short a credential here, not the service')
    }
  })

  it('asks a REPORTING kind to record the gap in its report', () => {
    // `tester-api` is `container-explore`: its deliverable IS its reply.
    expect(withGap('tester-api')).toContain(DEFAULT_CREDENTIAL_GAP_GUIDANCE.unusable)
  })

  it('never asks an IMPLEMENTER to record a failure it has no report for', () => {
    // `coder` is `container-coding`: it ends with a pushed commit and routinely no final text.
    const coder = withGap('coder')
    expect(coder).toContain(IMPLEMENTER_CREDENTIAL_GAP_GUIDANCE.unusable)
    expect(coder).not.toContain('record it as a failure')
  })
})
