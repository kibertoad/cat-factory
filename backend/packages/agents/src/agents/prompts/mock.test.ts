import type { AgentRunContext, FrontendConfig } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { userPromptFor } from '../catalog.js'
import { MOCK_AGENT_KIND, mockFrontendSection } from './mock.js'

function frontendConfig(overrides: Partial<FrontendConfig> = {}): FrontendConfig {
  return { backendBindings: [], ...overrides }
}

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: MOCK_AGENT_KIND,
    pipelineName: 'Frontend build & UI test',
    stepIndex: 2,
    isFinalStep: false,
    block: {
      title: 'Add checkout screen',
      type: 'frontend',
      description: 'Wire the checkout flow to the payments API.',
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('mockFrontendSection', () => {
  it('is absent for a backend service run (no frontend context)', () => {
    expect(
      mockFrontendSection(
        ctx({ block: { title: 'Auth', type: 'service', description: 'Auth service.' } }),
      ),
    ).toBeUndefined()
  })

  it('is absent for a non-mocker kind even with frontend context', () => {
    const context = ctx({
      agentKind: 'coder',
      frontend: { config: frontendConfig(), bindings: [] },
    })
    expect(mockFrontendSection(context)).toBeUndefined()
  })

  it('directs the mocker to the frontend mock mappings dir (WireMock --root-dir layout)', () => {
    const section = mockFrontendSection(
      ctx({
        frontend: {
          config: frontendConfig({ mockMappingsPath: 'wiremock/' }),
          bindings: [{ envVar: 'PUB_PAYMENTS_URL' }],
        },
      }),
    )
    expect(section).toBeDefined()
    // Uses the frame's configured root, trailing slash trimmed, and the mappings/__files layout.
    expect(section).toContain('`wiremock/mappings/*.json`')
    expect(section).toContain('`wiremock/__files/`')
    // Steers away from the backend docker-compose model.
    expect(section).toContain('NOT a docker-compose stack')
  })

  it('defaults to `mocks/` when the frame declares no mappings path', () => {
    const section = mockFrontendSection(
      ctx({ frontend: { config: frontendConfig(), bindings: [{ envVar: 'PUB_API_URL' }] } }),
    )
    expect(section).toContain('`mocks/mappings/*.json`')
  })

  it('lists the env vars to mock and excludes a live service under test', () => {
    const section = mockFrontendSection(
      ctx({
        frontend: {
          config: frontendConfig(),
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.env.example' },
            { envVar: 'PUB_PAYMENTS_URL' },
            { envVar: 'PUB_SEARCH_URL' },
          ],
        },
      }),
    )
    // The mocked upstreams are named; the live one is explicitly excluded from mocking.
    expect(section).toContain('PUB_PAYMENTS_URL')
    expect(section).toContain('PUB_SEARCH_URL')
    expect(section).toContain('Do NOT mock the live service(s) under test (PUB_API_URL)')
  })

  it('is folded into the mocker user prompt for a frontend run', () => {
    const prompt = userPromptFor(
      ctx({
        frontend: {
          config: frontendConfig(),
          bindings: [{ envVar: 'PUB_PAYMENTS_URL' }],
        },
      }),
    )
    expect(prompt).toContain('FRONTEND UI TEST')
    expect(prompt).toContain('`mocks/mappings/*.json`')
  })
})
