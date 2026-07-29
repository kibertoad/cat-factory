import type {
  AgentPromptRepository,
  AgentPromptRevision,
  AgentPromptSummary,
  Clock,
  SaveAgentPromptInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, requireWorkspace, ValidationError } from '@cat-factory/kernel'

/**
 * Bound on a stored agent-kind id. Kinds are an OPEN string set (a deployment registers its
 * own, exactly as model-preset `overrides` keys are unchecked), so membership is deliberately
 * not validated — but an unbounded path segment would still let junk rows accumulate.
 */
const MAX_AGENT_KIND_CHARS = 120

export interface AgentPromptServiceDependencies {
  agentPromptRepository: AgentPromptRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/**
 * A workspace's agent system-prompt overrides: the append-only revision log behind the
 * pipeline builder's prompt editor.
 *
 * The whole surface is three operations because the log IS the model — there is no update and
 * no delete. Editing a prompt appends a revision; going back to an older one appends a copy of
 * it; going back to what the product ships appends a revision with no text. The highest
 * revision is what runs.
 *
 * That shape is what makes "switch back to an older version" safe rather than destructive:
 * nothing a user does can lose a prompt they were running last week, and two people editing
 * the same kind cannot silently overwrite each other — the second append collides on the
 * revision number and is refused as a conflict, rather than being merged by last-write-wins.
 *
 * Resolving the live prompt for a RUN does not go through this service: the engine reads the
 * head directly in `AgentContextBuilder`, one point read per dispatch.
 */
export class AgentPromptService {
  private readonly prompts: AgentPromptRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock

  constructor(deps: AgentPromptServiceDependencies) {
    this.prompts = deps.agentPromptRepository
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
  }

  /**
   * The workspace's override index — one row per kind that has any revision. `customized` is
   * false for a kind whose head is a "back to the built-in" revision, so the builder badges
   * only the kinds actually deviating from what ships.
   */
  async listSummaries(workspaceId: string): Promise<AgentPromptSummary[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const heads = await this.prompts.listHeads(workspaceId)
    return heads.map((head) => ({
      agentKind: head.agentKind,
      revision: head.revision,
      customized: head.text !== null,
      updatedAt: head.createdAt,
    }))
  }

  /** One kind's full revision log, newest first. Empty for an untouched kind. */
  async listRevisions(workspaceId: string, agentKind: string): Promise<AgentPromptRevision[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.prompts.listRevisions(workspaceId, this.assertAgentKind(agentKind))
  }

  /**
   * Append a revision: new text, or `text: null` to go back to the shipped built-in. Returns
   * the whole refreshed log so the caller re-renders from the server's view rather than a
   * locally-guessed one.
   *
   * A save that would not change what runs appends NOTHING and returns the log unchanged. The
   * editor's save button is reachable without an edit (and a restore of the live revision is
   * the same request), and a log padded with identical entries makes the one revision someone
   * needs to find harder to spot.
   */
  async save(
    workspaceId: string,
    agentKind: string,
    input: SaveAgentPromptInput,
    userId?: string,
  ): Promise<AgentPromptRevision[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const kind = this.assertAgentKind(agentKind)
    const existing = await this.prompts.listRevisions(workspaceId, kind)
    const head = existing[0]

    // `restoredFrom` is presentation only, but a dangling one would render as a reference to a
    // revision the reader cannot open — so it is validated against the log rather than stored
    // as whatever the client sent.
    if (
      input.restoredFrom !== undefined &&
      !existing.some((r) => r.revision === input.restoredFrom)
    ) {
      throw new ValidationError('That revision does not exist for this agent.', {
        reason: 'unknown_revision',
        revision: input.restoredFrom,
      })
    }

    const current = head?.text ?? null
    if (current === input.text) return existing

    const revision: AgentPromptRevision = {
      agentKind: kind,
      revision: (head?.revision ?? 0) + 1,
      text: input.text,
      ...(input.restoredFrom !== undefined ? { restoredFrom: input.restoredFrom } : {}),
      createdAt: this.clock.now(),
      ...(userId ? { createdBy: userId } : {}),
    }

    try {
      await this.prompts.append(workspaceId, revision)
    } catch (error) {
      // The revision number came from the read above, so a second editor saving concurrently
      // makes this insert collide on the primary key. Distinguish that from a real store
      // failure by re-reading rather than by matching a driver-specific error shape (D1 and
      // Postgres report the violation differently, and getting that sniff wrong would report a
      // dead database as a merge conflict).
      const latest = await this.prompts.head(workspaceId, kind)
      if (latest && latest.revision >= revision.revision) {
        throw new ConflictError(
          'This prompt was changed by someone else. Reload and re-apply your edit.',
          'prompt_revision_conflict',
          { revision: latest.revision },
        )
      }
      throw error
    }
    return [revision, ...existing]
  }

  /** Trim + bound the kind id from the request path. Membership is deliberately not checked. */
  private assertAgentKind(agentKind: string): string {
    const kind = agentKind.trim()
    if (!kind || kind.length > MAX_AGENT_KIND_CHARS) {
      throw new ValidationError('Unknown agent.', { reason: 'invalid_agent_kind' })
    }
    return kind
  }
}
