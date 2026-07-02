import { describe, expect, it } from 'vitest'
import type { Block, Pipeline } from '@cat-factory/contracts'
import { frameAllowsVisualPipeline, pipelineHasVisualStep } from '@cat-factory/contracts'

// The pure predicates behind the slice-4c run-start gate (and the SPA's matching surface): a
// pipeline with a visual step (`tester-ui` / `visual-confirmation`) may run only on a frame with
// a UI to exercise — a `frontend` frame, or a frame a `frontend` frame links to.

function pipeline(agentKinds: string[]): Pick<Pipeline, 'agentKinds'> {
  return { agentKinds }
}

function frame(id: string, type: Block['type']): Pick<Block, 'id' | 'type'> {
  return { id, type }
}

/** A `frontend`-type frame block that binds `serviceBlockIds` as `service` upstreams. */
function frontendFrame(
  serviceBlockIds: string[],
): Pick<Block, 'level' | 'type' | 'frontendConfig'> {
  return {
    level: 'frame',
    type: 'frontend',
    frontendConfig: {
      backendBindings: serviceBlockIds.map((serviceBlockId) => ({
        envVar: 'PUB_API_URL',
        source: { kind: 'service', serviceBlockId },
      })),
    },
  }
}

describe('pipelineHasVisualStep', () => {
  it('is true for a `tester-ui` pipeline', () => {
    expect(pipelineHasVisualStep(pipeline(['coder', 'tester-ui', 'ci']))).toBe(true)
  })

  it('is true for a `visual-confirmation` pipeline', () => {
    expect(pipelineHasVisualStep(pipeline(['coder', 'visual-confirmation']))).toBe(true)
  })

  it('is false for a backend pipeline (`tester-api`, no visual step)', () => {
    expect(pipelineHasVisualStep(pipeline(['coder', 'tester-api', 'ci', 'merger']))).toBe(false)
  })
})

describe('frameAllowsVisualPipeline', () => {
  it('allows a `frontend` frame (it owns the app under test)', () => {
    expect(frameAllowsVisualPipeline(frame('blk_fe', 'frontend'), [])).toBe(true)
  })

  it('allows a service frame that a frontend frame links to', () => {
    const blocks = [frontendFrame(['blk_svc'])]
    expect(frameAllowsVisualPipeline(frame('blk_svc', 'service'), blocks)).toBe(true)
  })

  it('refuses a service frame with no frontend linked to it', () => {
    const blocks = [frontendFrame(['blk_other'])]
    expect(frameAllowsVisualPipeline(frame('blk_svc', 'service'), blocks)).toBe(false)
  })

  it('refuses a service frame when the only frontend binds a MOCK (not this service)', () => {
    const blocks: Pick<Block, 'level' | 'type' | 'frontendConfig'>[] = [
      {
        level: 'frame',
        type: 'frontend',
        frontendConfig: { backendBindings: [{ envVar: 'X', source: { kind: 'mock' } }] },
      },
    ]
    expect(frameAllowsVisualPipeline(frame('blk_svc', 'service'), blocks)).toBe(false)
  })

  it('refuses a `library` / `document` frame', () => {
    const blocks = [frontendFrame(['blk_svc'])]
    expect(frameAllowsVisualPipeline(frame('blk_lib', 'library'), blocks)).toBe(false)
    expect(frameAllowsVisualPipeline(frame('blk_doc', 'document'), blocks)).toBe(false)
  })

  it('refuses when the frame cannot be resolved (undefined/null)', () => {
    expect(frameAllowsVisualPipeline(undefined, [frontendFrame(['blk_svc'])])).toBe(false)
    expect(frameAllowsVisualPipeline(null, [frontendFrame(['blk_svc'])])).toBe(false)
  })
})
