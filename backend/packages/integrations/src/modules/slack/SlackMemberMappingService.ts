import type { Clock, WorkspaceRepository } from '@cat-factory/kernel'
import type { SlackMemberMappingEntry, SlackMemberMappingRepository } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'

// SlackMemberMappingService: an account's opt-in GitHub-user-id → Slack-member-id
// map, used to resolve @-mentions when a workspace enables them. Per-account (the
// same scope key as the connection): the workspace's account id, else the
// workspace id for the no-account dev path.

export interface SlackMemberMappingServiceDependencies {
  slackMemberMappingRepository: SlackMemberMappingRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

export class SlackMemberMappingService {
  constructor(private readonly deps: SlackMemberMappingServiceDependencies) {}

  /** The account's mapping entries (empty when unset). */
  async get(workspaceId: string): Promise<SlackMemberMappingEntry[]> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    return this.deps.slackMemberMappingRepository.getByAccount(accountKey)
  }

  /** Replace the account's mapping. Last write per GitHub user id wins. */
  async update(
    workspaceId: string,
    entries: SlackMemberMappingEntry[],
  ): Promise<SlackMemberMappingEntry[]> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    // De-duplicate by userId (a stable, deterministic map).
    const byUser = new Map<string, SlackMemberMappingEntry>()
    for (const entry of entries) byUser.set(entry.userId, entry)
    const deduped = [...byUser.values()]
    await this.deps.slackMemberMappingRepository.upsert(accountKey, deduped, this.deps.clock.now())
    return deduped
  }

  private async resolveAccountKey(workspaceId: string): Promise<string> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? workspaceId
  }
}
