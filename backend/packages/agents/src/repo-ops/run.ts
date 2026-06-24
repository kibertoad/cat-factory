import type { RepoOp, RepoOpContext } from '@cat-factory/kernel'

/**
 * Run an agent's pre/post-op hooks in order over a shared {@link RepoOpContext}. Each
 * op is deterministic backend work (read a baseline artifact, render + commit files);
 * a throw aborts the remaining ops and propagates so the engine fails the step.
 *
 * Lives in `@cat-factory/agents` (which owns the kind registry + the render lib the
 * post-ops use) so the orchestration engine can drive it without importing the server
 * HTTP layer — the engine sits below the server, see CLAUDE.md "Conventions".
 */
export async function runRepoOps(ops: readonly RepoOp[], ctx: RepoOpContext): Promise<void> {
  for (const op of ops) await op(ctx)
}
