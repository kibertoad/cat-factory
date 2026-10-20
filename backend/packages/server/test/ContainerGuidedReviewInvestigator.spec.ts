import { describe, expect, it, vi } from 'vitest'
import type {
  BlockRepository,
  GitHubInstallation,
  GitHubInstallationRepository,
  RepoProjectionRepository,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { ALL_SUBSCRIPTION_VENDORS, resolveModelRef } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, GUIDED_REVIEW_INVESTIGATOR_KIND } from '@cat-factory/agents'
import { ContainerGuidedReviewInvestigator } from '../src/agents/ContainerGuidedReviewInvestigator.js'
import { ContainerJobAuthResolver } from '../src/agents/containerJobAuth.js'
import { buildSingleKindModelResolver } from '../src/agents/singleKindModel.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// What the deep-answer dispatcher owns: the job it sends (read-only, a full checkout of the target
// branch with the PR head fetched, the reviewed commit named), the model it asks for (its own
// kind, with no frame to read), and how a poll result maps onto the port.

const INSTALLATION = {
  installationId: 99,
  workspaceId: 'ws_1',
  deletedAt: null,
} as unknown as GitHubInstallation

function transportRecording(view: RunnerJobView = { state: 'running' } as RunnerJobView) {
  const dispatched: { ref: RunnerJobRef; body: Record<string, unknown> }[] = []
  const released: RunnerJobRef[] = []
  const transport = {
    dispatch: vi.fn(async (ref: RunnerJobRef, body: Record<string, unknown>) => {
      dispatched.push({ ref, body })
    }),
    poll: vi.fn(async () => view),
    release: vi.fn(async (ref: RunnerJobRef) => {
      released.push(ref)
    }),
  } as unknown as RunnerTransport
  return { transport, dispatched, released }
}

function makeInvestigator(transport: RunnerTransport, blockGet = vi.fn(async () => null)) {
  return new ContainerGuidedReviewInvestigator({
    resolveTransport: async () => transport,
    installationRepository: {
      getByWorkspace: async () => INSTALLATION,
    } as unknown as GitHubInstallationRepository,
    repoRepository: {
      list: async () =>
        [{ githubId: 501, owner: 'acme', name: 'shop' }] as unknown as Awaited<
          ReturnType<RepoProjectionRepository['list']>
        >,
    },
    mintInstallationToken: async () => 'gh-token',
    resolveModel: buildSingleKindModelResolver({
      agentRouting: { default: { ref: { provider: 'qwen', model: 'qwen3-max' } }, byKind: {} },
      resolveBlockModel: (modelId) =>
        resolveModelRef(modelId, {
          directProviders: new Set(),
          subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
          cloudflareEnabled: true,
        }),
      blockRepository: { get: blockGet } as unknown as Pick<BlockRepository, 'get'>,
    }),
    auth: new ContainerJobAuthResolver({
      sessionService: {
        mint: vi.fn(async () => 'session-token'),
      } as unknown as ContainerSessionService,
      proxyBaseUrl: 'https://proxy.example/v1',
    }),
    agentKindRegistry: defaultAgentKindRegistry(),
  })
}

const REQUEST = {
  workspaceId: 'ws_1',
  jobId: 'grm_7',
  initiatedBy: 'usr_1',
  repo: { owner: 'acme', name: 'shop', provider: 'github' as const },
  prNumber: 42,
  baseRef: 'main',
  headSha: 'abc123',
  userPrompt: 'The thread so far: does the retry loop terminate?',
}

describe('ContainerGuidedReviewInvestigator', () => {
  it('dispatches a read-only explore job on the target branch, fetching the PR head', async () => {
    const { transport, dispatched } = transportRecording()
    const blockGet = vi.fn(async () => null)
    const handle = await makeInvestigator(transport, blockGet).start(REQUEST)

    expect(dispatched).toHaveLength(1)
    const { ref, body } = dispatched[0]!
    expect(ref).toMatchObject({ runId: 'grm_7', jobId: 'grm_7' })
    expect(body).toMatchObject({
      mode: 'explore',
      branch: 'main',
      full: true,
      reviewPrNumber: 42,
      executionId: 'grm_7',
      repo: { owner: 'acme', name: 'shop', baseBranch: 'main' },
      output: { kind: 'structured', repair: true },
    })
    expect(body).not.toHaveProperty('pr')
    expect(String(body.userPrompt)).toContain('`abc123`')
    // The kind's own prompt with its read-only guardrail, not a hand-written one.
    expect(String(body.systemPrompt)).toContain('read-only checkout')
    // No frame: nothing is read, and the routing default answers.
    expect(blockGet).not.toHaveBeenCalled()
    expect(handle.dispatch.model).toBe('qwen:qwen3-max')
    expect(GUIDED_REVIEW_INVESTIGATOR_KIND).toBe('guided-review-investigator')
  })

  it('maps a finished job to its report and a job with no answer to a failure', async () => {
    const done = transportRecording({
      state: 'done',
      result: { custom: { answer: 'Yes.', citations: [] } },
    } as unknown as RunnerJobView)
    const investigator = makeInvestigator(done.transport)
    const handle = await investigator.start(REQUEST)
    expect(await investigator.poll(handle)).toEqual({
      state: 'done',
      report: { answer: 'Yes.', citations: [] },
      model: 'qwen:qwen3-max',
    })

    const empty = transportRecording({ state: 'done', result: {} } as unknown as RunnerJobView)
    const second = makeInvestigator(empty.transport)
    expect(await second.poll(await second.start(REQUEST))).toMatchObject({ state: 'failed' })
  })

  it('releases the job it dispatched', async () => {
    const { transport, released } = transportRecording()
    const investigator = makeInvestigator(transport)
    await investigator.stop(await investigator.start(REQUEST))
    expect(released).toEqual([{ runId: 'grm_7', jobId: 'grm_7' }])
  })
})
