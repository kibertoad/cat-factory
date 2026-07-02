import { describe, expect, it } from 'vitest'
import type { Block, Pipeline } from '@cat-factory/contracts'
import {
  frameAllowsVisualPipeline,
  frontendOriginsForService,
  pipelineHasVisualStep,
} from '@cat-factory/contracts'

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

describe('frontendOriginsForService', () => {
  /** A `frontend` frame binding `serviceBlockId` with a given envVar + optional servePort. */
  function fe(
    serviceBlockId: string,
    { envVar = 'PUB_API_URL', servePort }: { envVar?: string; servePort?: number } = {},
  ): Pick<Block, 'level' | 'type' | 'frontendConfig'> {
    return {
      level: 'frame',
      type: 'frontend',
      frontendConfig: {
        backendBindings: [{ envVar, source: { kind: 'service', serviceBlockId } }],
        ...(servePort !== undefined ? { servePort } : {}),
      },
    }
  }

  it('emits the tester origin (default servePort 4173) of a frontend that binds the service', () => {
    expect(frontendOriginsForService('blk_svc', [fe('blk_svc')])).toEqual(['http://localhost:4173'])
  })

  it('uses the frontend frame’s configured servePort', () => {
    expect(frontendOriginsForService('blk_svc', [fe('blk_svc', { servePort: 5000 })])).toEqual([
      'http://localhost:5000',
    ])
  })

  it('sanitizes a reserved servePort to the default so the origin matches the actual served port', () => {
    // A reserved in-container port (8080 harness job server / 8089 WireMock) is bumped to 4173 by
    // `resolveFrontendServePort` when the app is actually served, so the CORS origin must too — a
    // raw `servePort` would inject `localhost:8080` while the app serves on 4173 (CORS fails).
    expect(frontendOriginsForService('blk_svc', [fe('blk_svc', { servePort: 8080 })])).toEqual([
      'http://localhost:4173',
    ])
    expect(frontendOriginsForService('blk_svc', [fe('blk_svc', { servePort: 8089 })])).toEqual([
      'http://localhost:4173',
    ])
  })

  it('dedupes + sorts origins across multiple binding frontends', () => {
    const origins = frontendOriginsForService('blk_svc', [
      fe('blk_svc', { servePort: 5000 }),
      fe('blk_svc', { servePort: 4173 }),
      fe('blk_svc', { servePort: 5000 }), // duplicate port collapses
    ])
    expect(origins).toEqual(['http://localhost:4173', 'http://localhost:5000'])
  })

  it('is empty when no frontend binds the service (mock-only or binds a different one)', () => {
    const mockOnly: Pick<Block, 'level' | 'type' | 'frontendConfig'> = {
      level: 'frame',
      type: 'frontend',
      frontendConfig: { backendBindings: [{ envVar: 'X', source: { kind: 'mock' } }] },
    }
    expect(frontendOriginsForService('blk_svc', [mockOnly, fe('blk_other')])).toEqual([])
  })

  it('ignores a binding with an empty envVar (an unfinished row the frontend never injects)', () => {
    expect(frontendOriginsForService('blk_svc', [fe('blk_svc', { envVar: '  ' })])).toEqual([])
  })
})
