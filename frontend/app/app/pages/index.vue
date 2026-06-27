<script setup lang="ts">
import BoardCanvas from '~/components/board/BoardCanvas.vue'
import SideBar from '~/components/layout/SideBar.vue'
import BoardToolbar from '~/components/layout/BoardToolbar.vue'
import SpendWarningBanner from '~/components/layout/SpendWarningBanner.vue'
import GitHubPatBanner from '~/components/layout/GitHubPatBanner.vue'
import AiProvidersBanner from '~/components/layout/AiProvidersBanner.vue'
import ProviderConfigBanner from '~/components/layout/ProviderConfigBanner.vue'
// Always-mounted, fast-path surfaces (opened frequently during a run / board edits, or
// store-driven so they must react from anywhere — kept eager for snappy open/close).
import PipelineBuilder from '~/components/pipeline/PipelineBuilder.vue'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import DecisionModal from '~/components/panels/DecisionModal.vue'
import AgentStepDetail from '~/components/panels/AgentStepDetail.vue'
import StepResultViewHost from '~/components/panels/StepResultViewHost.vue'
import BlockFocusView from '~/components/focus/BlockFocusView.vue'
import TaskSourceConnectModal from '~/components/tasks/TaskSourceConnectModal.vue'
import TaskImportModal from '~/components/tasks/TaskImportModal.vue'
import AddTaskModal from '~/components/board/AddTaskModal.vue'
import RecurringPipelineModal from '~/components/board/RecurringPipelineModal.vue'
import GitHubOnboarding from '~/components/github/GitHubOnboarding.vue'
import CommandBar from '~/components/layout/CommandBar.vue'
import PersonalCredentialModal from '~/components/providers/PersonalCredentialModal.vue'

// Heavy, rarely-open panels — code-split into their own chunks via defineAsyncComponent
// and mounted only while their ui open-flag is set (the v-if gates in the template), so
// they stay out of the initial bundle and don't run setup/watchers while closed.
const ObservabilityPanel = defineAsyncComponent(
  () => import('~/components/panels/ObservabilityPanel.vue'),
)
const KaizenPanel = defineAsyncComponent(() => import('~/components/kaizen/KaizenPanel.vue'))
const DocumentSourceConnectModal = defineAsyncComponent(
  () => import('~/components/documents/DocumentSourceConnectModal.vue'),
)
const DocumentImportModal = defineAsyncComponent(
  () => import('~/components/documents/DocumentImportModal.vue'),
)
const SpawnPreviewModal = defineAsyncComponent(
  () => import('~/components/documents/SpawnPreviewModal.vue'),
)
const BootstrapModal = defineAsyncComponent(
  () => import('~/components/bootstrap/BootstrapModal.vue'),
)
const AddServiceFromRepoModal = defineAsyncComponent(
  () => import('~/components/github/AddServiceFromRepoModal.vue'),
)
const GitHubPanel = defineAsyncComponent(() => import('~/components/github/GitHubPanel.vue'))
const SlackPanel = defineAsyncComponent(() => import('~/components/slack/SlackPanel.vue'))
const FragmentLibraryPanel = defineAsyncComponent(
  () => import('~/components/fragments/FragmentLibraryPanel.vue'),
)
const IntegrationsHub = defineAsyncComponent(
  () => import('~/components/layout/IntegrationsHub.vue'),
)
const PersonalSetupModal = defineAsyncComponent(
  () => import('~/components/layout/PersonalSetupModal.vue'),
)
const WorkspaceSettingsPanel = defineAsyncComponent(
  () => import('~/components/settings/WorkspaceSettingsPanel.vue'),
)
const AccountSettingsPanel = defineAsyncComponent(
  () => import('~/components/settings/AccountSettingsPanel.vue'),
)
const ObservabilityConnectionPanel = defineAsyncComponent(
  () => import('~/components/settings/ObservabilityConnectionPanel.vue'),
)
const ProviderConnectionPanel = defineAsyncComponent(
  () => import('~/components/settings/ProviderConnectionPanel.vue'),
)
const ModelConfigurationPanel = defineAsyncComponent(
  () => import('~/components/settings/ModelConfigurationPanel.vue'),
)
const LocalModelEndpointsPanel = defineAsyncComponent(
  () => import('~/components/settings/LocalModelEndpointsPanel.vue'),
)
const LocalModeSettingsPanel = defineAsyncComponent(
  () => import('~/components/settings/LocalModeSettingsPanel.vue'),
)
const SandboxPanel = defineAsyncComponent(() => import('~/components/sandbox/SandboxPanel.vue'))
const UserSecretsSection = defineAsyncComponent(
  () => import('~/components/settings/UserSecretsSection.vue'),
)
const OpenRouterCatalogPanel = defineAsyncComponent(
  () => import('~/components/settings/OpenRouterCatalogPanel.vue'),
)
const VendorCredentialsModal = defineAsyncComponent(
  () => import('~/components/providers/VendorCredentialsModal.vue'),
)
const AiProviderOnboardingModal = defineAsyncComponent(
  () => import('~/components/providers/AiProviderOnboardingModal.vue'),
)
const AiPresetMismatchDialog = defineAsyncComponent(
  () => import('~/components/providers/AiPresetMismatchDialog.vue'),
)

const workspace = useWorkspaceStore()
const github = useGitHubStore()
const models = useModelsStore()
const ui = useUiStore()
const aiReadiness = useAiReadiness()

// Load the board from the backend before rendering it.
onMounted(() => workspace.init())

// Per-session guards so each AI-onboarding dialog auto-opens at most once (later opens are
// user-driven from the banner). Reset on workspace switch by the catalog watcher below.
const autoOpenedSetup = ref(false)
const autoOpenedPreset = ref(false)

// Load the per-workspace model catalog as soon as a board is active (re-loaded per board —
// availability reflects that workspace's keys/subscriptions). This populates the AI-readiness
// signals regardless of which lazy picker happens to mount, so the onboarding prompts below
// can fire. Credential edits re-fetch via `models.refresh()` in the provider panels.
watch(
  () => workspace.workspaceId,
  (id, prev) => {
    if (id) void models.ensureLoaded(id)
    // Switching workspaces resets the per-session AI-onboarding state: dismissals and the
    // auto-open guards are scoped to one workspace, so a prompt dismissed in workspace A must
    // not suppress the (independent) prompt for workspace B that also lacks a usable source.
    if (prev !== undefined && id !== prev) {
      autoOpenedSetup.value = false
      autoOpenedPreset.value = false
      ui.resetAiOnboarding()
    }
  },
  { immediate: true },
)

// Auto-open the right AI-onboarding dialog once per session: the no-source prompt takes
// precedence over the preset-mismatch prompt. Honour the per-session dismissed flags so a
// user who closed the banner isn't re-interrupted, and only auto-open once each (later opens
// are user-driven from the banner). The prompts clear themselves once the gap is closed.
watch(
  () => [
    aiReadiness.ready.value,
    aiReadiness.hasUsableModel.value,
    aiReadiness.defaultPresetBroken.value,
  ],
  () => {
    if (!aiReadiness.ready.value) return
    if (!aiReadiness.hasUsableModel.value) {
      if (!autoOpenedSetup.value && !ui.aiSetupDismissed) {
        autoOpenedSetup.value = true
        ui.openAiProviderSetup()
      }
      return
    }
    if (aiReadiness.defaultPresetBroken.value) {
      if (!autoOpenedPreset.value && !ui.aiPresetDismissed) {
        autoOpenedPreset.value = true
        ui.openAiPresetMismatch()
      }
    }
  },
  { immediate: true },
)

// Probe the GitHub integration as soon as a board is active (re-probe per board —
// connections are per workspace). The result drives the onboarding gate below
// before the board mounts, so an unconnected user can't slip past it. SideBar
// re-probes once it mounts; that duplicate is harmless (probe is idempotent).
watch(
  () => workspace.workspaceId,
  (id) => {
    if (id) void github.probe()
  },
  { immediate: true },
)

// Hard gate: the App is enabled on the backend but this workspace has no
// installation yet. `available === null` means the probe is still in flight.
const needsGitHubInstall = computed(() => github.available === true && !github.connected)
const githubProbePending = computed(() => github.available === null)

// Subscribe to the backend's real-time event stream and (re)connect whenever the
// active workspace changes. Runs advance durably server-side; progress arrives as
// pushed events rather than by polling.
const stream = useWorkspaceStream()
watch(
  () => workspace.workspaceId,
  (id) => {
    stream.stop()
    if (id) stream.start()
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
    <!-- Local-mode setup prompt (missing GitHub PAT); floats over whatever is shown below. -->
    <GitHubPatBanner />
    <!-- AI-readiness prompt (no usable model source, or default preset uses unavailable models). -->
    <AiProvidersBanner v-if="workspace.ready && !needsGitHubInstall && !githubProbePending" />
    <!-- Infrastructure provider prompt (env/runner-pool wired but missing mandatory config). -->
    <ProviderConfigBanner v-if="workspace.ready && !needsGitHubInstall && !githubProbePending" />

    <!-- Resolving whether the GitHub App is installed, before we decide what to show. -->
    <div
      v-if="workspace.ready && githubProbePending"
      class="m-auto flex flex-col items-center gap-3 text-slate-400"
    >
      <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
      <span class="text-sm">Loading…</span>
    </div>

    <!-- App enabled but not installed on this workspace: hard onboarding gate. -->
    <GitHubOnboarding v-else-if="workspace.ready && needsGitHubInstall" />

    <template v-else-if="workspace.ready">
      <SideBar />
      <main class="relative min-w-0 flex-1">
        <BoardCanvas />
        <BoardToolbar />
        <SpendWarningBanner />
        <InspectorPanel />
        <BlockFocusView />
      </main>

      <!-- Always-mounted, fast-path surfaces. -->
      <PipelineBuilder />
      <DecisionModal />
      <AgentStepDetail />
      <StepResultViewHost />
      <TaskSourceConnectModal />
      <TaskImportModal />
      <AddTaskModal />
      <RecurringPipelineModal />
      <CommandBar />
      <PersonalCredentialModal />

      <!-- Lazy panels: mounted only while their ui open-flag is set, so each loads on
           first open (its own chunk) rather than bloating the initial bundle. -->
      <ObservabilityPanel v-if="ui.observabilityInstanceId" />
      <KaizenPanel v-if="ui.kaizenScreenOpen" />
      <DocumentSourceConnectModal v-if="ui.documentConnect" />
      <DocumentImportModal v-if="ui.documentImport" />
      <SpawnPreviewModal v-if="ui.spawnPreview" />
      <BootstrapModal v-if="ui.bootstrapOpen" />
      <AddServiceFromRepoModal v-if="ui.addServiceOpen" />
      <GitHubPanel v-if="ui.githubOpen" />
      <SlackPanel v-if="ui.slackOpen" />
      <FragmentLibraryPanel v-if="ui.fragmentLibraryOpen" />
      <IntegrationsHub v-if="ui.integrationsOpen" />
      <PersonalSetupModal v-if="ui.personalSetupOpen" />
      <WorkspaceSettingsPanel v-if="ui.workspaceSettingsOpen" />
      <AccountSettingsPanel v-if="ui.accountSettingsOpen" />
      <ObservabilityConnectionPanel v-if="ui.observabilityConnectionOpen" />
      <ProviderConnectionPanel v-if="ui.providerConnectionKind" />
      <ModelConfigurationPanel v-if="ui.modelConfigOpen" />
      <LocalModelEndpointsPanel v-if="ui.localModelsOpen" />
      <LocalModeSettingsPanel v-if="ui.localModeSettingsOpen" />
      <SandboxPanel v-if="ui.sandboxOpen" />
      <UserSecretsSection v-if="ui.userSecretsOpen" />
      <OpenRouterCatalogPanel v-if="ui.openRouterOpen" />
      <VendorCredentialsModal v-if="ui.vendorCredentialsOpen" />
      <AiProviderOnboardingModal v-if="ui.aiProviderSetupOpen" />
      <AiPresetMismatchDialog v-if="ui.aiPresetMismatchOpen" />
    </template>

    <!-- Backend unreachable / bootstrap failed -->
    <div v-else-if="workspace.error" class="m-auto max-w-md p-8 text-center">
      <UIcon name="i-lucide-plug-zap" class="mx-auto mb-3 h-10 w-10 text-amber-400" />
      <h1 class="mb-1 text-lg font-semibold">Can’t reach the backend</h1>
      <p class="mb-4 text-sm text-slate-400">{{ workspace.error }}</p>
      <UButton color="primary" icon="i-lucide-rotate-ccw" @click="workspace.init()">
        Retry
      </UButton>
    </div>

    <!-- Initial load -->
    <div v-else class="m-auto flex flex-col items-center gap-3 text-slate-400">
      <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
      <span class="text-sm">Loading board…</span>
    </div>
  </div>
</template>
