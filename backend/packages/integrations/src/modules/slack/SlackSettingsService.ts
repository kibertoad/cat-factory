import type { Clock, WorkspaceRepository } from '@cat-factory/kernel'
import type {
  SlackNotificationSettings,
  SlackSettingsRecord,
  SlackSettingsRepository,
  UpdateSlackSettingsInput,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { defaultSlackSettings } from './slack.logic.js'

// SlackSettingsService: a workspace's Slack notification routing (which types
// post, to which channel, and whether to @-mention). Per-workspace CRUD,
// mirroring RiskPolicyService. A workspace that never configured Slack reads
// back the defaults (everything disabled/unrouted).

export interface SlackSettingsServiceDependencies {
  slackSettingsRepository: SlackSettingsRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

function toSettings(record: SlackSettingsRecord): SlackNotificationSettings {
  let routes: SlackNotificationSettings['routes'] = {}
  try {
    const parsed = JSON.parse(record.routesJson)
    if (parsed && typeof parsed === 'object') {
      routes = parsed as SlackNotificationSettings['routes']
    }
  } catch {
    routes = {}
  }
  return { routes, mentionsEnabled: record.mentionsEnabled, updatedAt: record.updatedAt }
}

export class SlackSettingsService {
  constructor(private readonly deps: SlackSettingsServiceDependencies) {}

  /** A workspace's settings, falling back to the (no-op) defaults. */
  async get(workspaceId: string): Promise<SlackNotificationSettings> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = await this.deps.slackSettingsRepository.getByWorkspace(workspaceId)
    return record ? toSettings(record) : defaultSlackSettings(this.deps.clock.now())
  }

  /** Replace a workspace's routing settings. */
  async update(
    workspaceId: string,
    input: UpdateSlackSettingsInput,
  ): Promise<SlackNotificationSettings> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const updatedAt = this.deps.clock.now()
    const record: SlackSettingsRecord = {
      workspaceId,
      routesJson: JSON.stringify(input.routes),
      mentionsEnabled: input.mentionsEnabled,
      updatedAt,
    }
    await this.deps.slackSettingsRepository.upsert(record)
    return { routes: input.routes, mentionsEnabled: input.mentionsEnabled, updatedAt }
  }
}
