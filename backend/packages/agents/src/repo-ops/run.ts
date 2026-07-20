import type { RepoOp, RepoOpContext, RepoOpResult } from '@cat-factory/kernel'

/**
 * Run an agent's pre/post-op hooks in order over a shared {@link RepoOpContext}. Each
 * op is deterministic backend work (read a baseline artifact, render + commit files);
 * a throw aborts the remaining ops and propagates so the engine fails the step.
 *
 * Returns the merged {@link RepoOpResult} the ops reported: the last `pullRequest` an op opened
 * (a committing kind that delivers via PR, e.g. `spike`) and the concatenation of any
 * `contextFiles` preOps prepared for the agent (e.g. the `pr-reviewer` diff), so the engine can
 * record the PR on the block and materialise the injected files. Ops that report nothing leave
 * it empty.
 *
 * Lives in `@cat-factory/agents` (which owns the kind registry + the render lib the
 * post-ops use) so the orchestration engine can drive it without importing the server
 * HTTP layer — the engine sits below the server, see CLAUDE.md "Conventions".
 */
export async function runRepoOps(
  ops: readonly RepoOp[],
  ctx: RepoOpContext,
): Promise<RepoOpResult> {
  const merged: RepoOpResult = {}
  for (const op of ops) {
    const result = await op(ctx)
    if (result?.pullRequest) merged.pullRequest = result.pullRequest
    if (result?.contextFiles?.length)
      merged.contextFiles = [...(merged.contextFiles ?? []), ...result.contextFiles]
  }
  return merged
}
