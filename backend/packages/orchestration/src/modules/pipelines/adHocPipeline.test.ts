import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import { BLUEPRINT_AGENT_KIND, adHocPipelineIdFor } from '@cat-factory/contracts'
import { adHocPipelineFor } from './adHocPipeline.js'
import { validatePipelineShape } from './pipelineShape.js'

function registry(): AgentKindRegistry {
  const r = new AgentKindRegistry()
  r.registerAll([
    {
      kind: BLUEPRINT_AGENT_KIND,
      systemPrompt: 'map the repo',
      agent: { surface: 'container-explore' },
      presentation: {
        label: 'Blueprinter',
        icon: 'i-lucide-map',
        color: '#fff',
        description: 'Maps a repository into the service blueprint.',
        purposes: ['research'],
      },
    },
    {
      kind: 'org:unclassified',
      systemPrompt: 'do a thing',
      agent: { surface: 'container-explore' },
    },
  ])
  return r
}

describe('adHocPipelineFor', () => {
  it('synthesizes a one-step definition carrying the kind label and its own purpose', () => {
    const pipeline = adHocPipelineFor(BLUEPRINT_AGENT_KIND, registry())
    expect(pipeline.agentKinds).toEqual([BLUEPRINT_AGENT_KIND])
    expect(pipeline.name).toBe('Blueprinter')
    expect(pipeline.purpose).toBe('research')
  })

  it('stamps the shared ad-hoc id, so the SPA can recognise the run it produces', () => {
    // The wizard and the board both watch for a run under this id. A locally-built string here
    // would be a second spelling of the same fact, and the surface watching for it would simply
    // never see the run.
    expect(adHocPipelineFor(BLUEPRINT_AGENT_KIND, registry()).id).toBe(
      adHocPipelineIdFor(BLUEPRINT_AGENT_KIND),
    )
  })

  it('falls back to the build classifier for a kind that declared no purpose', () => {
    expect(adHocPipelineFor('org:unclassified', registry()).purpose).toBe('build')
    expect(adHocPipelineFor('org:unclassified', registry()).name).toBe('org:unclassified')
  })

  it('refuses a kind the registry does not know, naming it', () => {
    expect(() => adHocPipelineFor('org:nope', registry())).toThrow(ValidationError)
    expect(() => adHocPipelineFor('org:nope', registry())).toThrow(/org:nope/)
  })

  it('produces a chain the ordinary shape validation accepts', () => {
    // The point of synthesizing a Pipeline rather than a bespoke run path: every rule about what
    // may run still applies, unchanged and in one place.
    const pipeline = adHocPipelineFor(BLUEPRINT_AGENT_KIND, registry())
    expect(() =>
      validatePipelineShape({ agentKinds: pipeline.agentKinds, agentKindRegistry: registry() }),
    ).not.toThrow()
  })
})
