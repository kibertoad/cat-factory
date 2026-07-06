<script setup lang="ts">
import BoardCanvas from '~/components/board/BoardCanvas.vue'
import SideBar from '~/components/layout/SideBar.vue'
import BoardToolbar from '~/components/layout/BoardToolbar.vue'
import SpendWarningBanner from '~/components/layout/SpendWarningBanner.vue'
import ConnectionStatusBanner from '~/components/layout/ConnectionStatusBanner.vue'
import TranslationWarningBanner from '~/components/layout/TranslationWarningBanner.vue'
import GitHubPatBanner from '~/components/layout/GitHubPatBanner.vue'
import AiProvidersBanner from '~/components/layout/AiProvidersBanner.vue'
import ProviderConfigBanner from '~/components/layout/ProviderConfigBanner.vue'
import InfraSetupBanner from '~/components/layout/InfraSetupBanner.vue'
// Always-mounted, fast-path surfaces (opened frequently during a run / board edits, or
// store-driven so they must react from anywhere — kept eager for snappy open/close).
import PipelineBuilder from '~/components/pipeline/PipelineBuilder.vue'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import DecisionModal from '~/components/panels/DecisionModal.vue'
import AgentStepDetail from '~/components/panels/AgentStepDetail.vue'
import StepResultViewHost from '~/components/panels/StepResultViewHost.vue'
import AddTaskModal from '~/components/board/AddTaskModal.vue'
import CreateInitiativeModal from '~/components/board/CreateInitiativeModal.vue'
import GitHubOnboarding from '~/components/github/GitHubOnboarding.vue'
import CommandBar from '~/components/layout/CommandBar.vue'
import PersonalCredentialModal from '~/components/providers/PersonalCredentialModal.vue'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import KeyboardShortcutsHelp from '~/components/common/KeyboardShortcutsHelp.vue'

// Heavy, rarely-open panels — code-split into their own chunks via defineAsyncComponent
// and mounted only while their ui open-flag is set (the v-if gates in the template), so
// they stay out of the initial bundle and don't run setup/watchers while closed.
const ObservabilityPanel = defineAsyncComponent(
  () => import('~/components/panels/ObservabilityPanel.vue'),
)
const KaizenPanel = defineAsyncComponent(() => import('~/components/kaizen/KaizenPanel.vue'))
// Occasional, externally store-gated surfaces — deferred to their own chunks like the
// sibling document modals above. Each mounts only while its ui open-flag is set, so it
// loads on first open instead of bloating the initial bundle.
const BlockFocusView = defineAsyncComponent(() => import('~/components/focus/BlockFocusView.vue'))
const TaskSourceConnectModal = defineAsyncComponent(
  () => import('~/components/tasks/TaskSourceConnectModal.vue'),
)
const TaskImportModal = defineAsyncComponent(() => import('~/components/tasks/TaskImportModal.vue'))
const RecurringPipelineModal = defineAsyncComponent(
  () => import('~/components/board/RecurringPipelineModal.vue'),
)
const DocumentSourceConnectModal = defineAsyncComponent(
  () => import('~/components/documents/DocumentSourceConnectModal.vue'),
)
const DocumentImportModal = defineAsyncComponent(
  () => import('~/components/documents/DocumentImportModal.vue'),
)
const DocumentTemplatesModal = defineAsyncComponent(
  () => import('~/components/documents/DocumentTemplatesModal.vue'),
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
// Startup advisory for invalid / outdated pipelines — only mounted while open (auto-opened
// at most once per session by the watcher below), so it stays out of the initial bundle.
const PipelineHealthModal = defineAsyncComponent(
  () => import('~/components/pipeline/PipelineHealthModal.vue'),
)
// Startup advisory for new / outdated built-in merge presets — same once-per-session pattern.
const MergePresetHealthModal = defineAsyncComponent(
  () => import('~/components/settings/MergePresetHealthModal.vue'),
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
const PackageRegistriesPanel = defineAsyncComponent(
  () => import('~/components/settings/PackageRegistriesPanel.vue'),
)
const InfrastructureWindow = defineAsyncComponent(
  () => import('~/components/settings/InfrastructureWindow.vue'),
)
const EnvironmentSetupWizard = defineAsyncComponent(
  () => import('~/components/environments/EnvironmentSetupWizard.vue'),
)
const ModelConfigurationPanel = defineAsyncComponent(
  () => import('~/components/settings/ModelConfigurationPanel.vue'),
)
const LocalModelEndpointsPanel = defineAsyncComponent(
  () => import('~/components/settings/LocalModelEndpointsPanel.vue'),
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

// App-wide keyboard shortcuts (Escape to deselect, Delete to remove the selected block, ?
// for the cheatsheet). Registered ONCE here so a single global listener owns them.
useKeyboardShortcuts()

// Load the board from the backend before rendering it.
onMounted(() => {
  void workspace.init()
  // Honour a `cat-factory k3s` CLI hand-off (`?infraSetup=local-k3s&…`): open the Infrastructure
  // window pre-seeded with the provisioned connection so the user only pastes the token + saves.
  ui.consumeK3sSetupDeepLink()
})

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
      // Infra-setup banner session dismissals are per-workspace too — clear them on switch.
      ui.resetInfraSetupDismissals()
      // A different board has its own pipeline library, so re-arm the once-per-session advisory.
      ui.pipelineHealthSeen = false
    }
  },
  { immediate: true },
)

// Pipeline-health advisory: once a board is loaded, surface any invalid / outdated pipelines in
// a startup modal (auto-opened at most once per session per board — later opens are user-driven).
// Detection is reactive, so this fires as soon as the snapshot hydrates.
const { hasIssues: pipelineIssues } = usePipelineHealth()
watch(
  () => [workspace.ready, pipelineIssues.value],
  () => {
    if (workspace.ready && pipelineIssues.value) ui.maybeOpenPipelineHealth()
  },
  { immediate: true },
)
// Same advisory for built-in merge presets: surface new / outdated ones once per session. Defers
// to the pipeline advisory when both fire, so at most one modal auto-opens on a given load.
const { hasIssues: mergePresetIssues } = useMergePresetHealth()
watch(
  () => [workspace.ready, mergePresetIssues.value, ui.pipelineHealthOpen],
  () => {
    if (workspace.ready && mergePresetIssues.value && !ui.pipelineHealthOpen) {
      ui.maybeOpenMergePresetHealth()
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
// Top-level computed so the template auto-unwraps it (a nested ref read as `stream.connected`
// in the template would not unwrap, since `stream` is a plain object). Drives the headless
// `workspace-stream` readiness marker the e2e suite waits on.
const streamConnected = computed(() => stream.connected.value)
const streamEverConnected = computed(() => stream.everConnected.value)
const streamConnectionFailed = computed(() => stream.connectionFailed.value)
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
    <!-- Non-English locale warning (unofficial translation); slim strip above everything. -->
    <TranslationWarningBanner />
    <!-- Local-mode setup prompt (missing GitHub PAT); floats over whatever is shown below. -->
    <GitHubPatBanner />
    <!-- Stacked advisory banners: one click-through column so concurrent prompts never draw on
         top of each other (a fresh, unconfigured deployment can raise all three at once — no AI
         model + no runner pool + no storage). The wrapper is `pointer-events-none`; each banner
         re-enables pointer events on its own card, so the empty strip never intercepts clicks on
         the board chrome underneath.
         - AI-readiness (no usable model source, or default preset uses unavailable models).
         - Infrastructure provider (env/runner-pool wired but missing mandatory config).
         - Infra-setup (this deployment needs an executor / test env / storage the operator hasn't
           defined yet, so a class of agents can't run). -->
    <div
      v-if="workspace.ready && !needsGitHubInstall && !githubProbePending"
      class="pointer-events-none absolute inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-4 pt-4"
    >
      <AiProvidersBanner />
      <ProviderConfigBanner />
      <InfraSetupBanner />
    </div>

    <!-- Resolving whether the GitHub App is installed, before we decide what to show. -->
    <div
      v-if="workspace.ready && githubProbePending"
      class="m-auto flex flex-col items-center gap-3 text-slate-400"
    >
      <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
      <span class="text-sm">{{ $t('app.loading') }}</span>
    </div>

    <!-- App enabled but not installed on this workspace: hard onboarding gate. -->
    <GitHubOnboarding v-else-if="workspace.ready && needsGitHubInstall" />

    <template v-else-if="workspace.ready">
      <!-- Headless readiness marker for the e2e suite: reflects whether the real-time
           WebSocket is actually connected (and thus subscribed + resynced). A live spec must
           wait for this before driving a run, otherwise the run's first status events are
           broadcast to a not-yet-subscribed browser and missed, leaving the card stuck on a
           stale status until its assertion times out (the source of the e2e flakiness). Hidden
           and inert; no visual or behavioural effect. -->
      <span
        data-testid="workspace-stream"
        :data-connected="streamConnected ? 'true' : 'false'"
        hidden
      />
      <SideBar />
      <main class="relative min-w-0 flex-1">
        <BoardCanvas />
        <!-- Compact-viewport navbar trigger: the SideBar is an off-canvas drawer below
             lg, so surface a hamburger to open it. Hidden on lg+ (static sidebar). -->
        <!-- z-30 keeps the trigger above the centered BoardToolbar (z-20), whose
             max-width can otherwise reach this corner on the narrowest viewports. -->
        <UButton
          class="absolute start-3 top-3 z-30 lg:hidden"
          icon="i-lucide-menu"
          color="neutral"
          variant="soft"
          size="sm"
          :aria-label="ui.mobileNavOpen ? $t('nav.closeMenu') : $t('nav.openMenu')"
          data-testid="mobile-nav-toggle"
          @click="ui.toggleMobileNav()"
        />
        <BoardToolbar />
        <SpendWarningBanner />
        <ConnectionStatusBanner
          :connected="streamConnected"
          :ever-connected="streamEverConnected"
          :connection-failed="streamConnectionFailed"
        />
        <InspectorPanel />
        <!-- Code-split focus view. The fade lives here (not inside the component) so the
             leave animation still plays when `focusBlockId` clears and the v-if unmounts
             the chunk — an inner Transition would be torn down before it could run. -->
        <Transition name="focus-fade">
          <BlockFocusView v-if="ui.focusBlockId" />
        </Transition>
      </main>

      <!-- Always-mounted, fast-path surfaces. -->
      <PipelineBuilder />
      <DecisionModal />
      <AgentStepDetail />
      <StepResultViewHost />
      <AddTaskModal />
      <CreateInitiativeModal />
      <CommandBar />
      <PersonalCredentialModal />
      <ConfirmDialog />
      <KeyboardShortcutsHelp />

      <!-- Lazy panels: mounted only while their ui open-flag is set, so each loads on
           first open (its own chunk) rather than bloating the initial bundle. -->
      <TaskSourceConnectModal v-if="ui.taskConnect" />
      <TaskImportModal v-if="ui.taskImport" />
      <RecurringPipelineModal v-if="ui.addRecurringFrameId" />
      <ObservabilityPanel v-if="ui.observabilityInstanceId" />
      <KaizenPanel v-if="ui.kaizenScreenOpen" />
      <DocumentSourceConnectModal v-if="ui.documentConnect" />
      <DocumentImportModal v-if="ui.documentImport" />
      <DocumentTemplatesModal v-if="ui.documentTemplates" />
      <SpawnPreviewModal v-if="ui.spawnPreview" />
      <BootstrapModal v-if="ui.bootstrapOpen" />
      <AddServiceFromRepoModal v-if="ui.addServiceOpen" />
      <GitHubPanel v-if="ui.githubOpen" />
      <SlackPanel v-if="ui.slackOpen" />
      <FragmentLibraryPanel v-if="ui.fragmentLibraryOpen" />
      <PipelineHealthModal v-if="ui.pipelineHealthOpen" />
      <MergePresetHealthModal v-if="ui.mergePresetHealthOpen" />
      <IntegrationsHub v-if="ui.integrationsOpen" />
      <PersonalSetupModal v-if="ui.personalSetupOpen" />
      <WorkspaceSettingsPanel v-if="ui.workspaceSettingsOpen" />
      <AccountSettingsPanel v-if="ui.accountSettingsOpen" />
      <ObservabilityConnectionPanel v-if="ui.observabilityConnectionOpen" />
      <PackageRegistriesPanel v-if="ui.packageRegistriesOpen" />
      <InfrastructureWindow v-if="ui.infrastructureOpen" />
      <EnvironmentSetupWizard v-if="ui.environmentWizardOpen" />
      <ModelConfigurationPanel v-if="ui.modelConfigOpen" />
      <LocalModelEndpointsPanel v-if="ui.localModelsOpen" />
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
      <h1 class="mb-1 text-lg font-semibold">{{ $t('app.backendUnreachable') }}</h1>
      <p class="mb-4 text-sm text-slate-400">{{ workspace.error }}</p>
      <UButton color="primary" icon="i-lucide-rotate-ccw" @click="workspace.init()">
        {{ $t('common.retry') }}
      </UButton>
    </div>

    <!-- Initial load -->
    <div v-else class="m-auto flex flex-col items-center gap-3 text-slate-400">
      <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
      <span class="text-sm">{{ $t('app.loadingBoard') }}</span>
    </div>
  </div>
</template>
