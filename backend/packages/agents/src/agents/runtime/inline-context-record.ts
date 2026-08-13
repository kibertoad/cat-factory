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
// agent kind — the companions, the judges, the requirements reviewer, the task estimator, the
// document kinds, Kaizen itself — was invisible to it. On a real board the table held rows for
// `architect`, `coder`, `initiative-analyst` and `reviewer` and for nothing else, while
// `architect-companion` had 16 recorded LLM calls and no snapshot at all.
//
// That is a hole with a reader: `KaizenService` grades a step from its snapshot plus its calls,
// and told its grader "no provided-context snapshot was captured (prompt recording may be off)"
// for every inline kind. Recording was ON. There was no capture site. The grader, given a cause,
// duly recommended enabling a switch that was already enabled.
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
 * sibling's own comment records. The cost is one insert ahead of an LLM call.
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
