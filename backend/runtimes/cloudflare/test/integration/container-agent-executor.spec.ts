import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import {
  ContainerAgentExecutor,
  type RepoTarget,
  type ResolveRunnerTransport,
} from '../../src/infrastructure/ai/ContainerAgentExecutor'
import { CloudflareContainerTransport } from '../../src/infrastructure/containers/CloudflareContainerTransport'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'
import type { ExecutionContainer } from '../../src/infrastructure/containers/ExecutionContainer'

// ContainerAgentExecutor must compose the block's fragments into Pi's context,
// lock the model, dispatch a well-formed job to the per-run container, and report
// the PR — without leaking usage (the proxy meters that).

interface Dispatched {
  url: string
  body: Record<string, unknown>
}

/** Wrap a fake Durable Object namespace as the executor's transport resolver. */
function resolveTo(ns: DurableObjectNamespace<ExecutionContainer>): ResolveRunnerTransport {
  const transport = new CloudflareContainerTransport(ns)
  return () => Promise.resolve(transport)
}

function fakeContainer(
  respond: () => { error?: string } & Record<string, unknown>,
  capture: (d: Dispatched) => void,
): ResolveRunnerTransport {
  // Speaks the async harness protocol: POST /jobs starts a job (kind in the body,
  // returns its id), GET /jobs/{id} reports it as already finished with `respond()`.
  const stub = {
    fetch(url: string, init?: { method?: string; body?: string }) {
      if (init?.method === 'GET' || url.includes('/jobs/')) {
        return Promise.resolve(new Response(JSON.stringify({ state: 'done', result: respond() })))
      }
      const body = JSON.parse(init!.body!) as Record<string, unknown>
      capture({ url, body })
      return Promise.resolve(
        new Response(JSON.stringify({ jobId: body.jobId, state: 'running' }), { status: 202 }),
      )
    },
  }
  return resolveTo({
    idFromName: (name: string) => ({ name }),
    get: () => stub,
  } as unknown as DurableObjectNamespace<ExecutionContainer>)
}

const routing = (provider: string, model: string): AgentRouting => ({
  default: { ref: { provider, model } },
  byKind: {},
})

const repo: RepoTarget = { installationId: 7, owner: 'octo', name: 'app', baseBranch: 'main' }

function context(): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Build it',
    workspaceId: 'ws-1',
    executionId: 'ex-1',
    stepIndex: 1,
    isFinalStep: true,
    block: {
      id: 'blk-1',
      title: 'Rate limiter',
      type: 'service',
      description: 'Token bucket limiter',
      fragmentIds: ['node.performance'],
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('ContainerAgentExecutor', () => {
  it('dispatches a composed job and returns the PR', async () => {
    let dispatched: Dispatched | undefined
    const executor = new ContainerAgentExecutor({
      resolveTransport: fakeContainer(
        () => ({
          prUrl: 'https://github.com/octo/app/pull/42',
          branch: 'cat-factory/blk-1-abcd1234',
          summary: 'Added limiter',
        }),
        (d) => (dispatched = d),
      ),
      agentRouting: routing('qwen', 'qwen3-max'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })

    const result = await executor.run(context())

    expect(result.model).toBe('qwen:qwen3-max')
    expect(result.output).toContain('Added limiter')
    expect(result.output).toContain('https://github.com/octo/app/pull/42')
    expect(result.usage).toBeUndefined() // proxy meters; no double-count
    // The opened PR is surfaced structurally so the engine can record it on the block.
    expect(result.pullRequest).toEqual({
      url: 'https://github.com/octo/app/pull/42',
      number: 42,
      branch: 'cat-factory/blk-1-abcd1234',
    })

    const body = dispatched!.body
    // The dispatch discriminator travels in the body: the coder maps to the `run` kind.
    expect(dispatched!.url).toBe('http://container/jobs')
    expect(body.kind).toBe('run')
    expect(body.model).toBe('qwen3-max')
    expect(body.proxyBaseUrl).toBe('https://worker.example/v1')
    expect((body.repo as Record<string, unknown>).cloneUrl).toBe('https://github.com/octo/app.git')
    // The selected fragment was folded into the system prompt handed to Pi.
    expect(body.systemPrompt as string).toContain('Follow these standards')
    // The session token is model-locked to what the executor resolved.
    const session = await new ContainerSessionService({ secret: 'secret' }).verify(
      body.sessionToken as string,
    )
    expect(session).toMatchObject({ provider: 'qwen', model: 'qwen3-max', executionId: 'ex-1' })
  })

  it('dispatches read-only built-ins through the generic agent kind in explore mode', async () => {
    // architect/analysis are migrated onto the manifest-driven `agent` surface: they
    // dispatch `kind:'agent'` with `mode:'explore'` (not the bespoke `explore` dispatch
    // kind / `label`), clone the base branch read-only, request no structured output, and
    // map their prose straight to `output` with no PR — byte-parity with the old `/explore`
    // body bar the harness-internal temp-dir label.
    for (const agentKind of ['architect', 'analysis'] as const) {
      let dispatched: Dispatched | undefined
      const executor = new ContainerAgentExecutor({
        resolveTransport: fakeContainer(
          () => ({ summary: 'A design proposal.' }),
          (d) => (dispatched = d),
        ),
        agentRouting: routing('qwen', 'qwen3-max'),
        resolveBlockModel: () => undefined,
        resolveRepoTarget: () => Promise.resolve(repo),
        mintInstallationToken: () => Promise.resolve('gh-token'),
        sessionService: new ContainerSessionService({ secret: 'secret' }),
        proxyBaseUrl: 'https://worker.example/v1',
      })

      const result = await executor.run({ ...context(), agentKind })

      const body = dispatched!.body
      expect(body.kind).toBe('agent')
      expect(body.mode).toBe('explore')
      expect(body.label).toBeUndefined()
      expect(body.output).toBeUndefined() // prose, no structured JSON
      expect(body.pr).toBeUndefined()
      // No work/PR branch ⇒ clone the base, exactly like the old read-only body.
      expect(body.branch).toBe('main')
      expect(result.output).toContain('A design proposal.')
      expect(result.pullRequest).toBeUndefined()
    }
  })

  it('keys each step by a per-step job id while sharing the one per-run container', async () => {
    // Two steps of the SAME run (executionId 'ex-1') but different kinds must dispatch
    // with DISTINCT harness job ids — otherwise the harness reads one step's finished
    // result back for the other (the bug where `architect` returned the `spec-writer`'s
    // doc). The per-RUN container (idFromName argument) is the SAME for both, and the
    // poll reads each step's job by its own id.
    const idArgs: string[] = []
    const dispatchedJobIds: unknown[] = []
    const polledPaths: string[] = []
    const ns = {
      idFromName: (name: string) => {
        idArgs.push(name)
        return { name }
      },
      get: () => ({
        fetch: (url: string, init?: { method?: string; body?: string }) => {
          if (init?.method === 'GET' || url.includes('/jobs/')) {
            polledPaths.push(new URL(url).pathname)
            return Promise.resolve(
              new Response(JSON.stringify({ state: 'done', result: { summary: 'ok' } })),
            )
          }
          dispatchedJobIds.push((JSON.parse(init!.body!) as { jobId: unknown }).jobId)
          return Promise.resolve(
            new Response(JSON.stringify({ state: 'running' }), { status: 202 }),
          )
        },
      }),
    } as unknown as DurableObjectNamespace<ExecutionContainer>

    const executor = new ContainerAgentExecutor({
      resolveTransport: resolveTo(ns),
      agentRouting: routing('qwen', 'qwen3-max'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })

    const base = context()
    await executor.run({ ...base, agentKind: 'spec-writer' })
    await executor.run({ ...base, agentKind: 'architect' })

    // Distinct harness job ids per step…
    expect(dispatchedJobIds).toEqual(['ex-1-spec-writer', 'ex-1-architect'])
    // …polled by their own id…
    expect(polledPaths).toContain('/jobs/ex-1-architect')
    expect(polledPaths).toContain('/jobs/ex-1-spec-writer')
    // …but addressed to the one per-run container (the execution id).
    expect(new Set(idArgs)).toEqual(new Set(['ex-1']))
  })

  it('forwards live subtask progress from a still-running job poll', async () => {
    // A container whose GET /jobs/{id} reports the job still running, with the
    // latest todo counts attached — exactly the harness's running JobView.
    const runningWithProgress = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                state: 'running',
                progress: { completed: 3, inProgress: 1, total: 8 },
              }),
            ),
          ),
      }),
    } as unknown as DurableObjectNamespace<ExecutionContainer>

    const executor = new ContainerAgentExecutor({
      resolveTransport: resolveTo(runningWithProgress),
      agentRouting: routing('qwen', 'qwen3-max'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })

    const update = await executor.pollJob({ jobId: 'ex-1' })
    expect(update).toEqual({
      state: 'running',
      subtasks: { completed: 3, inProgress: 1, total: 8 },
    })
  })

  it('surfaces a job-level error from the container', async () => {
    const executor = new ContainerAgentExecutor({
      resolveTransport: fakeContainer(
        () => ({ error: 'Pi produced no file changes' }),
        () => {},
      ),
      agentRouting: routing('deepseek', 'deepseek-chat'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })
    await expect(executor.run(context())).rejects.toThrow(/no file changes/)
  })

  it('accepts workers-ai (served by the proxy via the AI binding, no key)', async () => {
    let dispatched: Dispatched | undefined
    const executor = new ContainerAgentExecutor({
      resolveTransport: fakeContainer(
        () => ({ prUrl: 'https://github.com/octo/app/pull/7', summary: 'done' }),
        (d) => (dispatched = d),
      ),
      agentRouting: routing('workers-ai', '@cf/qwen/qwen3-30b-a3b-fp8'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })

    const result = await executor.run(context())
    expect(result.model).toBe('workers-ai:@cf/qwen/qwen3-30b-a3b-fp8')
    // The session token is locked to the Workers AI model the proxy will serve.
    const session = await new ContainerSessionService({ secret: 'secret' }).verify(
      dispatched!.body.sessionToken as string,
    )
    expect(session).toMatchObject({ provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' })
  })

  it('rejects a provider the proxy cannot serve (anthropic)', async () => {
    const executor = new ContainerAgentExecutor({
      resolveTransport: fakeContainer(
        () => ({}),
        () => {},
      ),
      agentRouting: routing('anthropic', 'claude-3-5-sonnet'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(repo),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })
    await expect(executor.run(context())).rejects.toThrow(/is not supported/)
  })

  it('fails when no repo is connected', async () => {
    const executor = new ContainerAgentExecutor({
      resolveTransport: fakeContainer(
        () => ({}),
        () => {},
      ),
      agentRouting: routing('qwen', 'qwen3-max'),
      resolveBlockModel: () => undefined,
      resolveRepoTarget: () => Promise.resolve(null),
      mintInstallationToken: () => Promise.resolve('gh-token'),
      sessionService: new ContainerSessionService({ secret: 'secret' }),
      proxyBaseUrl: 'https://worker.example/v1',
    })
    await expect(executor.run(context())).rejects.toThrow(/No connected GitHub repository/)
  })
})
