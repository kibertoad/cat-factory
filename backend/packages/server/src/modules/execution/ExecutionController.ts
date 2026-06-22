import {
  approveStepSchema,
  rejectStepSchema,
  requestStepChangesSchema,
  resolveDecisionSchema,
  startExecutionSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'
import { personalGateForBlock } from '../providers/personalCredentialGate.js'

/**
 * Best-effort: when a user interacts with a running individual-usage run (resolving a
 * decision, approving a step), extend its personal-credential activation TTL if it's at
 * least half spent, so an actively-tended long run doesn't lapse. Never throws.
 */
function refreshActivation(c: Context<AppEnv>, executionId: string): void {
  const personal = c.get('container').personalSubscriptions
  const user = c.get('user')
  if (personal && user) void personal.refreshActivations(executionId, user.id).catch(() => {})
}

/**
 * The execution engine endpoints — starting/cancelling runs, resolving decisions
 * and merging PRs. Runs advance durably server-side via Cloudflare Workflows;
 * progress reaches the browser over the WebSocket events stream, not by polling.
 * Mounted under `/workspaces/:workspaceId`.
 */
export function executionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/blocks/:blockId/executions', jsonBody(startExecutionSchema), async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const blockId = param(c, 'blockId')
    const { pipelineId, password } = c.req.valid('json')
    // Individual-usage models (Claude/GLM/Codex) require the initiator's personal
    // subscription: resolve the initiator + an activation closure (throws 428 when a
    // password is needed). A run touching no individual-usage vendor gets a no-op gate.
    const { initiatedBy, activate } = await personalGateForBlock(
      container,
      workspaceId,
      blockId,
      pipelineId,
      c.get('user'),
      password,
    )
    const instance = await container.executionService.start(
      workspaceId,
      blockId,
      pipelineId,
      initiatedBy,
      activate,
    )
    return c.json(instance, 201)
  })

  app.delete('/blocks/:blockId/executions', async (c) => {
    const block = await c
      .get('container')
      .executionService.cancel(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(block)
  })

  app.post('/blocks/:blockId/merge', async (c) => {
    const block = await c
      .get('container')
      .executionService.mergePr(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(block)
  })

  // Current spend-safeguard status (token usage vs budget for this period).
  app.get('/spend', async (c) => {
    return c.json(await c.get('container').spendService.status())
  })

  // LLM observability for a run: the full per-call detail (prompts, responses,
  // token usage, output-limit headroom, transport-vs-execution latency) behind the
  // board's step rollups. Empty when the observability sink is not wired.
  app.get('/executions/:executionId/llm-metrics', async (c) => {
    const executionId = param(c, 'executionId')
    const observability = c.get('container').llmObservability
    const calls = observability
      ? await observability.listByExecution(param(c, 'workspaceId'), executionId)
      : []
    return c.json({ executionId, calls })
  })

  // LLM-friendly export of a run's model activity: a self-describing JSON bundle
  // (totals + per-agent insights + every call, with derived ratios) meant to be
  // handed straight to a model for analysis. Sets a download filename.
  app.get('/executions/:executionId/llm-metrics/export', async (c) => {
    const executionId = param(c, 'executionId')
    const observability = c.get('container').llmObservability
    const exported = observability
      ? await observability.exportForExecution(param(c, 'workspaceId'), executionId)
      : {
          kind: 'cat-factory.llm-metrics-export' as const,
          version: 1 as const,
          executionId,
          generatedAt: 0,
          totals: {
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
            upstreamMs: 0,
            overheadMs: 0,
            transportOverheadRatio: null,
            errors: 0,
            warnings: 0,
            truncatedCalls: 0,
          },
          insights: [],
          calls: [],
        }
    c.header('content-disposition', `attachment; filename="llm-metrics-${executionId}.json"`)
    return c.json(exported)
  })

  // Resume runs paused by the spend safeguard in this workspace.
  app.post('/spend/resume', async (c) => {
    const instances = await c
      .get('container')
      .executionService.resumePaused(param(c, 'workspaceId'))
    return c.json(instances)
  })

  app.post(
    '/executions/:executionId/decisions/:decisionId',
    jsonBody(resolveDecisionSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.resolveDecision(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'decisionId'),
          c.req.valid('json').choice,
        )
      refreshActivation(c, param(c, 'executionId'))
      return c.json(instance)
    },
  )

  // Approve a step's gated proposal (optionally with a human-edited proposal);
  // the run advances to the next step carrying it forward as context.
  app.post(
    '/executions/:executionId/steps/:approvalId/approve',
    jsonBody(approveStepSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.approveStep(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'approvalId'),
          { proposal: c.req.valid('json').proposal },
        )
      refreshActivation(c, param(c, 'executionId'))
      return c.json(instance)
    },
  )

  // Request changes on a gated proposal: the step re-runs with the reviewer's
  // freeform feedback and/or per-block comments.
  app.post(
    '/executions/:executionId/steps/:approvalId/request-changes',
    jsonBody(requestStepChangesSchema),
    async (c) => {
      const { feedback, comments } = c.req.valid('json')
      const instance = await c
        .get('container')
        .executionService.requestStepChanges(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'approvalId'),
          { feedback, comments },
        )
      return c.json(instance)
    },
  )

  // Reject a gated proposal: the run stops entirely (a terminal, retryable failure).
  app.post(
    '/executions/:executionId/steps/:approvalId/reject',
    jsonBody(rejectStepSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.rejectStep(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'approvalId'),
          c.req.valid('json').reason,
        )
      return c.json(instance)
    },
  )

  return app
}
