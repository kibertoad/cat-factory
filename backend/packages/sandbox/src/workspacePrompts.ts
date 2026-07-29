import type { AgentPromptRevision, SandboxPromptVersion } from '@cat-factory/kernel'
import { sandboxKindMeta, SANDBOX_AGENT_KINDS } from './baselines.js'

// The workspace's OWN agent prompts, projected into the sandbox's prompt-version vocabulary.
//
// The two features are the halves of one workflow: the sandbox is where a prompt is chosen, the
// pipeline builder's editor is where one is deployed. Without this projection the sandbox's only
// control is the prompt the PRODUCT ships — so on a workspace that has edited a kind, every
// experiment measures its candidate against text nobody there runs, silently and while looking
// entirely correct.
//
// These rows are SYNTHESIZED per request and never persisted, exactly like the shipped baselines:
// the workspace's revision log is the source of truth, so a prompt edited in the builder shows up
// here on the next read with no sync step that could fall behind.

/** The id a workspace revision is addressed by in the sandbox's prompt-version space. */
export function workspacePromptVersionId(agentKind: string, revision: number): string {
  return `workspace:${agentKind}:${revision}`
}

/** The lineage all of one kind's workspace revisions share, so the browser groups them. */
export function workspacePromptLineageId(agentKind: string): string {
  return `workspace:${agentKind}`
}

/** Parse a {@link workspacePromptVersionId} back to its parts; null when it is not one. */
export function parseWorkspacePromptVersionId(
  id: string,
): { agentKind: string; revision: number } | null {
  const parts = id.split(':')
  if (parts.length !== 3 || parts[0] !== 'workspace') return null
  const revision = Number(parts[2])
  if (!Number.isInteger(revision) || revision < 1) return null
  return { agentKind: parts[1]!, revision }
}

/**
 * Project a workspace's agent-prompt revisions into synthetic {@link SandboxPromptVersion}s.
 *
 * Three rules, each with a silent failure mode if it were the other way:
 *
 * - **Only kinds the sandbox can actually run** ({@link SANDBOX_AGENT_KINDS}) are projected.
 *   Listing a prompt for a kind no experiment can exercise offers a matrix cell that can never
 *   be built.
 * - **A revert revision (`text: null`) is skipped.** It means "follow the shipped prompt", so it
 *   has no text to run — and it is already represented by the shipped baseline row beside it.
 *   Projecting it would put an empty system prompt into a matrix.
 * - **`version` is the workspace's own revision number**, not a sandbox-local counter, so the
 *   number a user reads here is the number the pipeline builder's history shows them. A parallel
 *   numbering would make "promote v3" and "restore v3" mean different things.
 *
 * `live` marks the row currently running, computed from the HEAD of each kind's log rather than
 * from the highest projected row: a revert is the head and is not projected, so on a reverted kind
 * nothing is live and inferring it from the highest number would point at a prompt that stopped
 * running when someone went back to the built-in.
 */
export function workspacePromptVersions(
  revisions: readonly AgentPromptRevision[],
): SandboxPromptVersion[] {
  // The head of each kind's log — the revision that actually runs, revert included.
  const headByKind = new Map<string, AgentPromptRevision>()
  for (const revision of revisions) {
    const seen = headByKind.get(revision.agentKind)
    if (!seen || revision.revision > seen.revision) headByKind.set(revision.agentKind, revision)
  }
  return revisions
    .filter((revision) => revision.text !== null && sandboxKindMeta(revision.agentKind))
    .sort((a, b) => a.agentKind.localeCompare(b.agentKind) || b.revision - a.revision)
    .map((revision) => {
      const meta = sandboxKindMeta(revision.agentKind)
      const head = headByKind.get(revision.agentKind)
      return {
        id: workspacePromptVersionId(revision.agentKind, revision.revision),
        lineageId: workspacePromptLineageId(revision.agentKind),
        agentKind: revision.agentKind,
        name: meta?.label ?? revision.agentKind,
        origin: 'workspace' as const,
        // Non-null by the filter above; the cast keeps the projection total without a `!`.
        systemText: revision.text ?? '',
        basePromptId: meta?.basePromptId ?? null,
        version: revision.revision,
        parentId: null,
        labels: [],
        ...(head?.revision === revision.revision ? { live: true } : {}),
        createdAt: revision.createdAt,
        createdBy: revision.createdBy ?? null,
        archivedAt: null,
      }
    })
}

/** The agent kinds the sandbox can run, for the batched revision read that feeds the projection. */
export function sandboxPromptKinds(agentKind?: string): string[] {
  const all = SANDBOX_AGENT_KINDS.map((meta) => meta.agentKind)
  return agentKind ? all.filter((kind) => kind === agentKind) : all
}
