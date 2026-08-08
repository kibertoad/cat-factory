import type { AgentRunContext, RunnerJobRef, RunnerTransport } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The artifact-upload seam a browser-driven kind carries: the container POSTs its captured
// screenshots back to the harness ingest route, reusing the SAME session token it already holds
// for the LLM proxy. It is keyed off the kind's DECLARED `ui` image, read from the agent-kind
// registry — the same registry the transport's dispatch image comes from.
//
// The registry dependency is OPTIONAL and the executor normalises an absent one to the default
// registry, so these drive an executor built WITHOUT one: that is what a facade leaving the
// default implicit produces, and the failure it guards is silent. Reading the un-normalised dep
// instead dispatched `tester-ui` to the browser image with NO upload seam, so every screenshot it
// captured was lost with no error raised anywhere.
//
// A separate spec from `containerAgentJobBody.spec.ts` (which snapshots whole bodies per kind)
// because that file sits at its `max-lines` ceiling.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } },
  byKind: {},
}

function makeExecutor(depsOverride: Partial<ContainerAgentExecutorDependencies> = {}): {
  executor: ContainerAgentExecutor
  bodies: Record<string, unknown>[]
} {
  const bodies: Record<string, unknown>[] = []
  const transport: RunnerTransport = {
    async dispatch(_ref: RunnerJobRef, spec) {
      bodies.push(spec as Record<string, unknown>)
    },
    async poll() {
      return { state: 'running' }
    },
  }
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      repoId: '1001',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService: {
      async mint() {
        return 'SESSION-TOKEN'
      },
    } as unknown as ContainerSessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    ensureWorkBranch: async () => true,
    ...depsOverride,
  }
  return { executor: new ContainerAgentExecutor(deps), bodies }
}

const context = (agentKind: string, over: Partial<AgentRunContext> = {}): AgentRunContext =>
  ({
    agentKind,
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Implement it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...over,
  }) as unknown as AgentRunContext

describe('ContainerAgentExecutor artifact-upload seam', () => {
  it('rides a tester-ui body when the registry is left implicit', async () => {
    const { executor, bodies } = makeExecutor()
    await executor.startJob(context('tester-ui'))
    expect(bodies[0]!.artifactUpload).toEqual({
      url: 'https://proxy.test/v1/artifacts/ingest',
      token: 'SESSION-TOKEN',
    })
  })

  it('is absent for a kind that declares no ui image', async () => {
    const { executor, bodies } = makeExecutor()
    await executor.startJob(context('tester-api'))
    expect(bodies[0]!.artifactUpload).toBeUndefined()
  })

  it('carries the reference-design manifest the engine resolved, ids only', async () => {
    const { executor, bodies } = makeExecutor()
    await executor.startJob(
      context('tester-ui', {
        referenceScreenshots: {
          files: [{ view: 'Checkout', artifactId: 'art_1', fileName: 'Checkout.png' }],
          omitted: [],
        },
      }),
    )
    // The bytes never ride the body: a design frame is a full-page PNG and this JSON crosses
    // every transport and is persisted with the dispatch.
    expect(bodies[0]!.referenceScreenshots).toEqual({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 'SESSION-TOKEN',
      files: [{ artifactId: 'art_1', fileName: 'Checkout.png', view: 'Checkout' }],
    })
  })

  it('sends no manifest when the task holds no reference', async () => {
    // The engine ASKED and found none (an empty set), which is a real answer, but an empty
    // manifest would have the harness create a directory that reads as designs giving nothing.
    const { executor, bodies } = makeExecutor()
    await executor.startJob(
      context('tester-ui', { referenceScreenshots: { files: [], omitted: [] } }),
    )
    expect(bodies[0]!.referenceScreenshots).toBeUndefined()
  })

  it('sends the CAPPED views even when no file survived the cap', async () => {
    // A set the cap emptied is not a task with no references: the agent still has to capture
    // those views, and on disk "nobody mentioned it" and "the design has no such screen" are the
    // same absence. So this manifest carries names and no files.
    const { executor, bodies } = makeExecutor()
    await executor.startJob(
      context('tester-ui', { referenceScreenshots: { files: [], omitted: ['Settings'] } }),
    )
    expect(bodies[0]!.referenceScreenshots).toEqual({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 'SESSION-TOKEN',
      files: [],
      omitted: ['Settings'],
    })
  })

  it('is withheld when the deployment wired no proxy for the token to reach', async () => {
    // No `proxyBaseUrl` ⇒ no ingest URL and no session token. A half-built seam (a URL with no
    // token) would fail inside the container at upload time, long after the run looked healthy.
    const { executor, bodies } = makeExecutor({ proxyBaseUrl: undefined })
    await executor.startJob(context('tester-ui'))
    expect(bodies[0]!.artifactUpload).toBeUndefined()
  })
})
