import type { WorkspaceSnapshot } from '~/types/domain'
import { useAgentConfigStore } from '~/stores/agentConfig'
import { useAgentRunsStore } from '~/stores/agentRuns'
import { useAgentsStore } from '~/stores/agents'
import { useBoardStore } from '~/stores/board'
import { useBrainstormStore } from '~/stores/brainstorm'
import { useClarityStore } from '~/stores/clarity'
import { useConsensusStore } from '~/stores/consensus'
import { useEnvironmentTestStore } from '~/stores/environmentTest'
import { useExecutionStore } from '~/stores/execution'
import { useFragmentsStore } from '~/stores/fragments'
import { useGitHubStore } from '~/stores/github'
import { useInitiativesStore } from '~/stores/initiative'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useConsensusGroupsStore } from '~/stores/consensusGroups'
import { useNotificationsStore } from '~/stores/notifications'
import { usePipelinesStore } from '~/stores/pipelines'
import { useProviderConnectionsStore } from '~/stores/providerConnections'
import { useRecurringPipelinesStore } from '~/stores/recurringPipelines'
import { useRequirementsStore } from '~/stores/requirements'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useServiceFragmentDefaultsStore } from '~/stores/serviceFragmentDefaults'
import { useServicesStore } from '~/stores/services'
import { useSharedStacksStore } from '~/stores/sharedStacks'
import { useSkillsStore } from '~/stores/skills'
import { useTaskTypesStore } from '~/stores/taskTypes'
import { useTrackerStore } from '~/stores/tracker'
import { useTutorialStore } from '~/stores/tutorial'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import { buildWorkspaceCapabilitiesManifest } from '~/modular/capabilities'

/**
 * Drop the per-block caches that are NOT part of the snapshot (reviews, brainstorm/consensus
 * sessions, the GitHub projection) so a switched-to board never shows the previous one's stale
 * state. These are lazily reloaded/re-probed per board, so clearing on a same-board refresh
 * would needlessly wipe an open review window — hence only on an actual id change.
 */
export function resetPerBoardCaches() {
  useRequirementsStore().reset()
  useClarityStore().reset()
  useBrainstormStore().reset()
  useConsensusStore().reset()
  useGitHubStore().reset()
  useInitiativesStore().reset()
  useDocInterviewStore().reset()
  // The fragment picker catalog is per-board (the merged tenant catalog), so drop
  // it too — the next inspector open re-fetches it for the switched-to board rather
  // than showing the previous board's (or a raw-id placeholder for) fragments.
  useFragmentsStore().invalidate()
}

/**
 * Fan a workspace snapshot out into the per-feature data stores. Extracted verbatim from the
 * `workspace` store's `hydrate` (which keeps the workspace-scoped state it owns + the
 * board-switch cache reset) so the ordering of the hydrate calls is preserved exactly — a
 * size-only split, not a new seam.
 *
 * `boardSince` (captured BEFORE this snapshot's fetch) lets the board store preserve any block
 * live-`upsert`ed while the fetch was in flight, so a slower refresh can't clobber a newer live
 * status (see `useBoardStore().hydrate`).
 */
export function applySnapshotToStores(snapshot: WorkspaceSnapshot, boardSince?: number) {
  useUserSettingsStore().hydrate(snapshot.userSettings ?? null)
  // The signed-in user's tutorial progress MERGES rather than replaces (see the store): both id
  // lists are grow-only sets, so a snapshot must never un-say a walkthrough this browser finished
  // while the mirror write was failing. Absent ⇒ no server copy, and the local one stands.
  useTutorialStore().mergeServerProgress(snapshot.tutorialProgress ?? null)
  useBoardStore().hydrate(snapshot.blocks, boardSince)
  useBoardStore().hydrateArchived(snapshot.archivedServices ?? [])
  usePipelinesStore().hydrate(
    snapshot.pipelines,
    snapshot.pipelineCatalogVersions,
    snapshot.retiredPipelines,
    snapshot.pipelineCatalogNames,
  )
  useExecutionStore().hydrate(snapshot.executions, snapshot.workspace.id)
  useAgentRunsStore().hydrate(snapshot.bootstrapJobs ?? [], snapshot.workspace.id)
  useAgentRunsStore().hydrateEnvConfigRepair(snapshot.envConfigRepairJobs ?? [])
  useEnvironmentTestStore().hydrate(snapshot.environmentTestRuns ?? [], snapshot.workspace.id)
  useNotificationsStore().hydrate(snapshot.notifications ?? [])
  useRiskPoliciesStore().hydrate(snapshot.riskPolicies ?? [], snapshot.riskPolicyCatalogVersions)
  useSharedStacksStore().hydrate(snapshot.sharedStacks ?? [])
  useWorkspaceSettingsStore().hydrate(snapshot.settings)
  useAgentConfigStore().hydrate(snapshot.agentConfigCatalog ?? [])
  useModelPresetsStore().hydrate(snapshot.modelPresets ?? [], snapshot.modelPresetCatalogVersions)
  useConsensusGroupsStore().hydrate(snapshot.consensusGroups ?? [])
  useServiceFragmentDefaultsStore().hydrate(snapshot.serviceFragmentDefaults?.fragmentIds)
  useRecurringPipelinesStore().hydrate(snapshot.recurringPipelines ?? [])
  useInitiativesStore().hydrate(snapshot.initiatives)
  // Registered initiative presets (built-in generic + any a deployment mixed in): drive the
  // create picker and which planning pipeline "Run planning" starts. Workspace-independent.
  useInitiativesStore().hydratePresets(snapshot.initiativePresets)
  useTrackerStore().hydrate(snapshot.trackerSettings)
  useServicesStore().hydrate(snapshot.mounts ?? [], snapshot.serviceCatalog ?? [])
  // Hydrate the deployment's backend-registered capabilities from ONE shared per-workspace
  // remote capability manifest carrying BOTH custom agent kinds AND custom task types (its
  // version covers both, so an unchanged snapshot no-ops both stores). Each store reads its
  // own slot off it, so a proprietary agent kind renders as a first-class palette block +
  // result view and a proprietary task type as a first-class create-task choice + card badge.
  // Swapped wholesale per workspace (no global-catalog mutation).
  const capabilities = buildWorkspaceCapabilitiesManifest(
    snapshot.customAgentKinds ?? [],
    snapshot.customTaskTypes ?? [],
  )
  useAgentsStore().hydrateCapabilities(capabilities)
  // The deployment's registered agent-kind variants (alternate prompts for existing kinds), so
  // the builder can offer them per step and the run views can name the one a step ran under.
  useAgentsStore().hydrateVariants(snapshot.agentKindVariants ?? [])
  // The deployment's registered generative binary integrations, so the builder's binary-output
  // picker can offer a step's `generatorIds` from the same set run admission validates against.
  // …and whether that set could not be read at all, which the picker must say rather than
  // render as an empty deployment (see `binaryGeneratorsUnavailable` on the snapshot).
  useAgentsStore().hydrateBinaryGenerators(
    snapshot.binaryGenerators ?? [],
    snapshot.binaryGeneratorsUnavailable === true,
  )
  useTaskTypesStore().hydrateCapabilities(capabilities)
  // The per-step parameters each registered gate declares, so a gated step's config form in the
  // builder comes from the gate's own registration rather than a form hard-coded per gate.
  usePipelinesStore().hydrateGateConfigForms(snapshot.gateConfigForms ?? [])
  // The account's repo-sourced Claude Skills catalog (shared across its workspaces), so the
  // pipeline builder's per-step skill picker has its options. A straight replace.
  useSkillsStore().hydrate(snapshot.skills ?? [])
  // Seed the connect form's backend-kind selectors (built-in + any custom backend a
  // deployment registered), so a programmatically-registered env/runner backend is a
  // first-class connect option instead of a hardcoded manifest/kubernetes list.
  useProviderConnectionsStore().registerBackendKinds({
    environment: snapshot.environmentBackendKinds,
    'runner-pool': snapshot.runnerBackendKinds,
  })
}
