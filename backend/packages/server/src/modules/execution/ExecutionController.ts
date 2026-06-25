import {
  approveStepSchema,
  rejectStepSchema,
  requestStepChangesSchema,
  resolveDecisionSchema,
  resolveIterationCapSchema,
  restartFromStepSchema,
  startExecutionSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'
import {
  personalGateForBlock,
  personalGateForRun,
  readPersonalPassword,
  remintActivations,
} from '../providers/personalCredentialGate.js'

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
    const { pipelineId } = c.req.valid('json')
    // Individual-usage models (Claude/GLM/Codex) require the initiator's personal
    // subscription: resolve the initiator + an activation closure (throws 428 when a
    // password is needed). The password rides on the X-Personal-Password header. A run
    // touching no individual-usage vendor gets a no-op gate.
    const { initiatedBy, activate } = await personalGateForBlock(
      container,
      workspaceId,
      blockId,
      pipelineId,
      c.get('user'),
      readPersonalPassword(c),
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
    // Manual confirm-merge runs the engine GitHub client under the acting user's
    // ambient context, so their per-user PAT (when set) authors the merge.
    const block = await runWithInitiator(c.get('user')?.id, () =>
      c.get('container').executionService.mergePr(param(c, 'workspaceId'), param(c, 'blockId')),
    )
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

  // The complete context provided to each container agent in a run: the composed
  // system + user prompts, the best-practice fragment bodies folded in, and the full
  // content of the files injected into the container. Empty when the agent-context
  // sink is not wired or the workspace disabled storing it.
  app.get('/executions/:executionId/agent-context', async (c) => {
    const executionId = param(c, 'executionId')
    const observability = c.get('container').agentContextObservability
    const snapshots = observability
      ? await observability.listByExecution(param(c, 'workspaceId'), executionId)
      : []
    return c.json({ executionId, snapshots })
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
      // Re-mint the run's activation BEFORE the engine advances + dispatches the next step.
      await remintActivations(c, param(c, 'workspaceId'), param(c, 'executionId'))
      const instance = await c
        .get('container')
        .executionService.resolveDecision(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'decisionId'),
          c.req.valid('json').choice,
        )
      return c.json(instance)
    },
  )

  // Approve a step's gated proposal (optionally with a human-edited proposal);
  // the run advances to the next step carrying it forward as context.
  app.post(
    '/executions/:executionId/steps/:approvalId/approve',
    jsonBody(approveStepSchema),
    async (c) => {
      // Re-mint the run's activation BEFORE the engine advances + dispatches the next step.
      await remintActivations(c, param(c, 'workspaceId'), param(c, 'executionId'))
      const instance = await c
        .get('container')
        .executionService.approveStep(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'approvalId'),
          { proposal: c.req.valid('json').proposal },
        )
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
      // The step re-runs (dispatches) — re-mint the run's activation first.
      await remintActivations(c, param(c, 'workspaceId'), param(c, 'executionId'))
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

  // Resolve a companion step parked at its automatic-rework cap: one more round /
  // proceed accepting the current output / stop and reset the task to phase zero. The
  // companion analogue of the requirements gate's resolve-exceeded; guarded so the
  // generic approve/reject can't short-circuit it.
  app.post(
    '/executions/:executionId/steps/:approvalId/resolve-exceeded',
    jsonBody(resolveIterationCapSchema),
    async (c) => {
      // extra-round / proceed re-dispatch the next agent step — re-mint first.
      await remintActivations(c, param(c, 'workspaceId'), param(c, 'executionId'))
      const instance = await c
        .get('container')
        .executionService.resolveCompanionExceeded(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'approvalId'),
          c.req.valid('json').choice,
        )
      return c.json(instance)
    },
  )

  // Restart a run from a chosen step: re-run from `fromStepIndex` onward (resetting
  // that step + every later step's iteration counters) while keeping the earlier
  // steps' outputs as handoff context. Works on a run in any state — the engine tears
  // down a still-running driver/container first. Mints a fresh run id, so it re-drives
  // like a retry. Individual-usage models (Claude/GLM/Codex) need the initiator's
  // personal subscription, resolved + activated here (428 when a password is needed).
  app.post('/executions/:executionId/restart', jsonBody(restartFromStepSchema), async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const executionId = param(c, 'executionId')
    const { fromStepIndex } = c.req.valid('json')
    const { initiatedBy, activate } = await personalGateForRun(
      container,
      workspaceId,
      executionId,
      c.get('user'),
      readPersonalPassword(c),
    )
    const instance = await container.executionService.restartFromStep(
      workspaceId,
      executionId,
      fromStepIndex,
      initiatedBy,
      activate,
    )
    return c.json(instance)
  })

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
