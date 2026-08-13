import type {
  AgentContextRecorder,
  AgentRunContext,
  Logger,
  ModelRef,
  RecordAgentContextInput,
} from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'

// The agent-context observability snapshot for an INLINE dispatch.
//
// `agent_context_snapshots` had exactly one producer, `ContainerAgentExecutor`, so every inline
// AGENT KIND was invisible to it. On a real board the table held rows for `architect`, `coder`,
// `initiative-analyst` and `reviewer` and for nothing else, while `architect-companion` had 16
// recorded LLM calls and no snapshot at all.
//
// That is a hole with a reader: `KaizenService` grades a step from its snapshot plus its calls,
// and told its grader "no provided-context snapshot was captured (prompt recording may be off)"
// for every inline kind. Recording was ON. There was no capture site. The grader, given a cause,
// duly recommended enabling a switch that was already enabled.
//
// WHAT THIS COVERS is every kind DISPATCHED through `AiAgentExecutor` — the companions, the
// inline document kinds, the task estimator, any registered `surface: 'inline'` kind a deployment
// adds. What it does NOT cover is the services that call `generateText` themselves rather than
// through an agent-kind dispatch: the judges (`JudgeService`), the requirements and clarity
// reviewers (`IterativeReviewService`, `RequirementReviewService`), the tester-quality reviewer,
// the bug-hunt assessor, the document interviewer, and Kaizen's own grading call. Each composes its
// own prompts at its own call site and none of them is a step dispatch, so a snapshot for those is
// a separate piece of work, not a flag flip. Until it is done, their steps take the "no snapshot is
// available" branch of the Kaizen prompt, which is why that branch names no cause: it cannot tell
// this from a deployment with recording switched off.
//
// This is the sibling of the server layer's `buildAgentContextRecord` and deliberately NOT a
// reuse of it: that one projects a container JOB BODY, and its whole reason for existing is the
// allow-list keeping a clone token, a proxy session token or a credential-bearing URL out of the
// snapshot. An inline call has no body and no credentials to leak — the values here are the two
// prompt strings this executor just composed and the fragments it folded into them — so the two
// projections share a target type and nothing else. The service behind the recorder scrubs and
// size-bounds everything either way.

/**
 * Project one inline dispatch into a snapshot.
 *
 * `contextFiles` is empty because an inline call HAS no injected files: there is no checkout and
 * no `.cat-context` tree, and the standards a `context-files` kind would have read from disk are
 * folded into the system prompt instead (see the executor's `composeBlockSystemPrompt` call). An
 * empty list is the honest reading and matches what a reader of the snapshot can verify from the
 * prompts beside it.
 *
 * `harness` names the subscription CLI when the deployment serves this ref by driving one as a
 * host subprocess, and is null for an ordinary HTTP-provider call. Same rule as the container
 * projection: record what actually served it, never a guess.
 */
export function buildInlineAgentContextRecord(input: {
  context: AgentRunContext
  ref: ModelRef
  systemPrompt: string
  userPrompt: string
  workspaceId: string
  executionId: string
  harness: string | null
}): RecordAgentContextInput {
  const { context, ref, workspaceId, executionId, harness } = input
  return {
    workspaceId,
    executionId,
    agentKind: context.agentKind,
    stepIndex: context.stepIndex,
    model: `${ref.provider}:${ref.model}`,
    harness,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    fragments: (context.block.resolvedFragments ?? []).map((fragment) => ({
      id: fragment.id,
      body: fragment.body,
    })),
    contextFiles: [],
    extras: {
      pipelineName: context.pipelineName,
      mode: 'inline',
      decisions: context.decisions,
      // The rework this dispatch is answering, projected exactly as the container sibling does: the
      // feedback verbatim (the whole of what the producer was told to fix) plus the FACT that a
      // prior proposal was handed back, without the proposal itself, which is already the previous
      // dispatch's own snapshot. It is the field a stalled-companion investigation starts from — a
      // rework round is otherwise indistinguishable from a first pass in this record.
      ...(context.revision
        ? { revision: { feedback: context.revision.feedback, hadPriorProposal: true } }
        : {}),
    },
  }
}

/**
 * File an inline dispatch's snapshot, if the deployment wired a recorder at all.
 *
 * AWAITED before the model call rather than after it, for two reasons. A call that THROWS is
 * exactly the one whose provided context someone wants to read, and a snapshot filed only on the
 * success path would be missing from every failure. And on the Worker an un-awaited insert is
 * dropped when the isolate hibernates on the next durable step, which is what the container
 * sibling's own comment records.
 *
 * So the cost is on the critical path by design, and it is one insert: the per-workspace gate the
 * recorder asks first reads through the shared settings cache where a facade has one (see
 * `AgentContextObservabilityService`), rather than a SELECT per dispatch.
 *
 * Best-effort: recording must never break a dispatch, and a recorder whose store is unreachable
 * says so once through the logger rather than failing the step.
 */
export async function recordInlineAgentContext(
  recorder: AgentContextRecorder | undefined,
  logger: Logger,
  input: Parameters<typeof buildInlineAgentContextRecord>[0],
): Promise<void> {
  if (!recorder) return
  await runBestEffort(
    logger,
    'inlineAgent.recordAgentContext',
    () => recorder.record(buildInlineAgentContextRecord(input)),
    {
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      agentKind: input.context.agentKind,
    },
  )
}
