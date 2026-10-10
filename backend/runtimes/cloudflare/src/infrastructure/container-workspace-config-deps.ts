import type { CoreDependencies } from '@cat-factory/orchestration'
import type { D1Database } from '@cloudflare/workers-types'
import { D1AgentPromptRepository } from './repositories/D1AgentPromptRepository'
import { D1ConsensusGroupRepository } from './repositories/D1ConsensusGroupRepository'
import { D1ModelPresetRepository } from './repositories/D1ModelPresetRepository'
import { D1ServiceFragmentDefaultsRepository } from './repositories/D1ServiceFragmentDefaultsRepository'
import { D1TaskTypeSuppressionRepository } from './repositories/D1TaskTypeSuppressionRepository'
import { D1WorkspaceAgentSettingsRepository } from './repositories/D1WorkspaceAgentSettingsRepository'

/**
 * The per-workspace CONFIGURATION libraries: what a board has decided about how its runs behave,
 * as opposed to the work itself.
 *
 * A mixin rather than six lines in `container.ts` because of that module's file-size ratchet (the
 * `selectPerUserDeps` precedent), but the grouping stands on its own. Every member is
 * workspace-keyed, holds no secret material, is `workspace`-scoped on the mothership persistence
 * allow-list, and is edited from a settings or builder surface rather than written by the engine.
 * So the next such library lands here, beside the ones that already share that shape, instead of in
 * the middle of the run-path repositories where nothing would mark it as configuration.
 *
 * Unconditional: none needs a binding, a key or a flag beyond the main database, so none of these
 * features is ever silently off. Mirrored on the Node facade by the corresponding entries in
 * `container-core-deps.ts`.
 */
export function selectWorkspaceConfigDeps(db: D1Database): Partial<CoreDependencies> {
  return {
    modelPresetRepository: new D1ModelPresetRepository({ db }),
    // The consensus-GROUP library: the estimate-gated panels a pipeline step escalates to.
    // Always wired (no secret material): the panels only run when the optional consensus
    // executor is enabled, but the library is editable and snapshot-visible regardless.
    consensusGroupRepository: new D1ConsensusGroupRepository({ db }),
    agentPromptRepository: new D1AgentPromptRepository({ db }),
    workspaceAgentSettingsRepository: new D1WorkspaceAgentSettingsRepository({ db }),
    // Which registered REUSABLE OPERATIONS this board offers (migration 0083). Read by the settings
    // controller, by the board snapshot's catalog projection, and on the creation path.
    taskTypeSuppressionRepository: new D1TaskTypeSuppressionRepository({ db }),
    serviceFragmentDefaultsRepository: new D1ServiceFragmentDefaultsRepository({ db }),
  }
}
