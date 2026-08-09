import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { resolveRunImages } from './run-images.js'

const registry = defaultAgentKindRegistry()

// A dispatch must not fail because a task's pictures could not be read. Resolving the artifact
// store reads the ACCOUNT's content-storage settings, and that repository decrypts inside itself,
// so a mothership node deliberately cannot reach it: left to propagate, this failed every dispatch
// of every building kind there — which is exactly how it was found.
describe('resolveRunImages: a failed read degrades, it does not wedge the run', () => {
  it('answers nothing when the store cannot be resolved at all', async () => {
    const logger = createRecordingLogger()
    const resolved = await resolveRunImages(
      {
        agentKindRegistry: registry,
        logger,
        resolveBinaryArtifactStore: async () => {
          throw new Error("Method 'accountSettingsRepository.getByAccount' is not callable")
        },
      },
      'coder',
      'ws',
      'blk',
    )
    expect(resolved).toEqual({})
    // Loud to the OPERATOR, who can act on it, and silent to the agent, who cannot: a read that
    // failed cannot say whether the task had a picture at all.
    const warned = logger.lines.find((line) => line.level === 'warn')
    expect(warned?.msg).toContain('Run image read failed')
    expect(warned?.fields?.agentKind).toBe('coder')
  })

  it('answers nothing when the reference read itself fails', async () => {
    const logger = createRecordingLogger()
    const store = {
      listByBlock: async () => {
        throw new Error('store is down')
      },
      listByDocuments: async () => [],
    } as never
    const resolved = await resolveRunImages(
      {
        agentKindRegistry: registry,
        logger,
        resolveBinaryArtifactStore: async () => store,
      },
      'tester-ui',
      'ws',
      'blk',
    )
    // The capture path degrades the same way, and always could: this is the shared resolution.
    expect(resolved).toEqual({})
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true)
  })
})
