import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  Block,
  EnvironmentHandle,
} from '@cat-factory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeApp } from '../helpers'
import {
  bearerManifest,
  readyEnvBody,
  recordingFetch,
  TEST_API_TOKEN,
} from './environment.fixtures'

/** Captures the context each agent step receives, so we can assert discovery. */
class RecordingAgentExecutor implements AgentExecutor {
  readonly contexts: AgentRunContext[] = []
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    this.contexts.push(context)
    return { output: 'ok', model: 'recording', confidence: context.isFinalStep ? 1 : undefined }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('deployer agent + environment discovery', () => {
  it('provisions deterministically and surfaces the env to the tester step', async () => {
    const stub = recordingFetch(() => ({ body: readyEnvBody() }))
    vi.stubGlobal('fetch', stub.fn)

    const recorder = new RecordingAgentExecutor()
    const app = makeApp(recorder)
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/environments/connection`, {
      manifest: bearerManifest(),
      secrets: { API_TOKEN: TEST_API_TOKEN },
    })

    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'environment',
      position: { x: 0, y: 0 },
    })
    const task = await app.call<Block>('POST', `/workspaces/${ws}/blocks/${frame.body.id}/tasks`, {
      title: 'Run e2e suite',
    })

    const pipeline = await app.call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
      name: 'Deploy & test',
      agentKinds: ['deployer', 'tester'],
    })
    await app.call('POST', `/workspaces/${ws}/blocks/${task.body.id}/executions`, {
      pipelineId: pipeline.body.id,
    })
    await app.drive(ws)

    // The deployer step ran deterministically (not through the agent executor),
    // so the recorder only saw the tester step.
    expect(stub.calls.some((c) => c.url === 'https://envs.test/api/environments')).toBe(true)
    expect(recorder.contexts.map((c) => c.agentKind)).toEqual(['tester'])

    // The tester discovered the live environment in its context.
    const tester = recorder.contexts[0]!
    expect(tester.environment).toBeDefined()
    expect(tester.environment!.url).toBe('https://env-1.envs.test')
    expect(tester.environment!.status).toBe('ready')
    expect(tester.environment!.access).toEqual({ scheme: 'bearer', token: 'env-access-tok' })

    // The environment is in the registry, keyed off the deployed block.
    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${ws}/environments`)
    expect(envs.body).toHaveLength(1)
    expect(envs.body[0]!.blockId).toBe(task.body.id)
    expect(envs.body[0]!.status).toBe('ready')
  })
})
