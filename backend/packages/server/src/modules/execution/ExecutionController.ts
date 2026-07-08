import {
  approveStepContract,
  cancelExecutionContract,
  exportExecutionLlmMetricsContract,
  getExecutionAgentContextContract,
  getExecutionLlmMetricsContract,
  getExecutionSearchQueriesContract,
  getSpendStatusContract,
  getWorkspaceUsageContract,
  mergeBlockContract,
  rejectStepContract,
  requestStepChangesContract,
  resolveDecisionContract,
  restartExecutionContract,
  resumeSpendContract,
  startExecutionContract,
  resolveStepExceededContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
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

  buildHonoRoute(app, startExecutionContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
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

  buildHonoRoute(app, cancelExecutionContract, async (c) => {
    const block = await c
      .get('container')
      .executionService.cancel(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(block, 200)
  })

  buildHonoRoute(app, mergeBlockContract, async (c) => {
    // Manual confirm-merge runs the engine GitHub client under the acting user's
    // ambient context, so their per-user PAT (when set) authors the merge.
    const block = await runWithInitiator(c.get('user')?.id, () =>
      c
        .get('container')
        .executionService.mergePr(param(c, 'workspaceId'), c.req.valid('param').blockId),
    )
    return c.json(block, 200)
  })

  // Current spend-safeguard status (token usage vs budget for this period).
  buildHonoRoute(app, getSpendStatusContract, async (c) => {
    return c.json(await c.get('container').spendService.status(param(c, 'workspaceId')), 200)
  })

  // Usage report for this period: token usage broken down by billing kind / vendor /
  // model — both metered API calls and flat-rate subscription harness usage. Powers the
  // "Usage" settings tab. (Reporting only; the budget gate above still counts metered.)
  buildHonoRoute(app, getWorkspaceUsageContract, async (c) => {
    return c.json(
      await c.get('container').spendService.usageBreakdown(param(c, 'workspaceId')),
      200,
    )
  })

  // LLM observability for a run: the full per-call detail (prompts, responses,
  // token usage, output-limit headroom, transport-vs-execution latency) behind the
  // board's step rollups. Empty when the observability sink is not wired.
  buildHonoRoute(app, getExecutionLlmMetricsContract, async (c) => {
    const executionId = c.req.valid('param').executionId
    const observability = c.get('container').llmObservability
    const calls = observability
      ? await observability.listByExecution(param(c, 'workspaceId'), executionId)
      : []
    return c.json({ executionId, calls }, 200)
  })

  // The complete context provided to each container agent in a run: the composed
  // system + user prompts, the best-practice fragment bodies folded in, and the full
  // content of the files injected into the container. Empty when the agent-context
  // sink is not wired or the workspace disabled storing it.
  buildHonoRoute(app, getExecutionAgentContextContract, async (c) => {
    const executionId = c.req.valid('param').executionId
    const observability = c.get('container').agentContextObservability
    const snapshots = observability
      ? await observability.listByExecution(param(c, 'workspaceId'), executionId)
      : []
    return c.json({ executionId, snapshots }, 200)
  })

  // The web searches each container agent in a run performed through the search proxy:
  // the query text, the provider that served it, and the result count. Empty when the
  // search-query sink is not wired or the workspace disabled storing agent context.
  buildHonoRoute(app, getExecutionSearchQueriesContract, async (c) => {
    const executionId = c.req.valid('param').executionId
    const observability = c.get('container').searchQueryObservability
    const searchQueries = observability
      ? await observability.listByExecution(param(c, 'workspaceId'), executionId)
      : []
    return c.json({ executionId, searchQueries }, 200)
  })

  // LLM-friendly export of a run's model activity: a self-describing JSON bundle
  // (totals + per-agent insights + every call, with derived ratios) meant to be
  // handed straight to a model for analysis. Sets a download filename.
  buildHonoRoute(app, exportExecutionLlmMetricsContract, async (c) => {
    const executionId = c.req.valid('param').executionId
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
            cachedPromptTokens: 0,
            cacheHitRate: null,
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
    return c.json(exported, 200)
  })

  // Resume runs paused by the spend safeguard in this workspace.
  buildHonoRoute(app, resumeSpendContract, async (c) => {
    const instances = await c
      .get('container')
      .executionService.resumePaused(param(c, 'workspaceId'))
    return c.json(instances, 200)
  })

  buildHonoRoute(app, resolveDecisionContract, async (c) => {
    const { executionId, decisionId } = c.req.valid('param')
    // Re-mint the run's activation BEFORE the engine advances + dispatches the next step.
    await remintActivations(c, param(c, 'workspaceId'), executionId)
    const instance = await c
      .get('container')
      .executionService.resolveDecision(
        param(c, 'workspaceId'),
        executionId,
        decisionId,
        c.req.valid('json').choice,
      )
    return c.json(instance, 200)
  })

  // Approve a step's gated proposal (optionally with a human-edited proposal);
  // the run advances to the next step carrying it forward as context.
  buildHonoRoute(app, approveStepContract, async (c) => {
    const { executionId, approvalId } = c.req.valid('param')
    // Re-mint the run's activation BEFORE the engine advances + dispatches the next step.
    await remintActivations(c, param(c, 'workspaceId'), executionId)
    const instance = await c
      .get('container')
      .executionService.approveStep(param(c, 'workspaceId'), executionId, approvalId, {
        proposal: c.req.valid('json').proposal,
      })
    return c.json(instance, 200)
  })

  // Request changes on a gated proposal: the step re-runs with the reviewer's
  // freeform feedback and/or per-block comments.
  buildHonoRoute(app, requestStepChangesContract, async (c) => {
    const { executionId, approvalId } = c.req.valid('param')
    const { feedback, comments } = c.req.valid('json')
    // The step re-runs (dispatches) — re-mint the run's activation first.
    await remintActivations(c, param(c, 'workspaceId'), executionId)
    const instance = await c
      .get('container')
      .executionService.requestStepChanges(param(c, 'workspaceId'), executionId, approvalId, {
        feedback,
        comments,
      })
    return c.json(instance, 200)
  })

  // Resolve a companion step parked at its automatic-rework cap: one more round /
  // proceed accepting the current output / stop and reset the task to phase zero. The
  // companion analogue of the requirements gate's resolve-exceeded; guarded so the
  // generic approve/reject can't short-circuit it.
  buildHonoRoute(app, resolveStepExceededContract, async (c) => {
    const { executionId, approvalId } = c.req.valid('param')
    // extra-round / proceed re-dispatch the next agent step — re-mint first.
    await remintActivations(c, param(c, 'workspaceId'), executionId)
    const instance = await c
      .get('container')
      .executionService.resolveCompanionExceeded(
        param(c, 'workspaceId'),
        executionId,
        approvalId,
        c.req.valid('json').choice,
      )
    return c.json(instance, 200)
  })

  // Restart a run from a chosen step: re-run from `fromStepIndex` onward (resetting
  // that step + every later step's iteration counters) while keeping the earlier
  // steps' outputs as handoff context. Works on a run in any state — the engine tears
  // down a still-running driver/container first. Mints a fresh run id, so it re-drives
  // like a retry. Individual-usage models (Claude/GLM/Codex) need the initiator's
  // personal subscription, resolved + activated here (428 when a password is needed).
  buildHonoRoute(app, restartExecutionContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const executionId = c.req.valid('param').executionId
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
    return c.json(instance, 200)
  })

  // Reject a gated proposal: the run stops entirely (a terminal, retryable failure).
  buildHonoRoute(app, rejectStepContract, async (c) => {
    const { executionId, approvalId } = c.req.valid('param')
    const instance = await c
      .get('container')
      .executionService.rejectStep(
        param(c, 'workspaceId'),
        executionId,
        approvalId,
        c.req.valid('json').reason,
      )
    return c.json(instance, 200)
  })

  return app
}
