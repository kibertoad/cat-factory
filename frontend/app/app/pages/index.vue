<script setup lang="ts">
import BoardCanvas from '~/components/board/BoardCanvas.vue'
import SideBar from '~/components/layout/SideBar.vue'
import BoardTopOverlays from '~/components/layout/BoardTopOverlays.vue'
import TranslationWarningBanner from '~/components/layout/TranslationWarningBanner.vue'
// Always-mounted, fast-path surfaces (opened frequently during a run / board edits, or
// store-driven so they must react from anywhere — kept eager for snappy open/close).
import PipelineBuilder from '~/components/pipeline/PipelineBuilder.vue'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import DecisionModal from '~/components/panels/DecisionModal.vue'
import AgentStepDetail from '~/components/panels/AgentStepDetail.vue'
import StepResultViewHost from '~/components/panels/StepResultViewHost.vue'
import AppOverlayHost from '~/components/panels/AppOverlayHost.vue'
import AddTaskModal from '~/components/board/AddTaskModal.vue'
import ReviewFrictionDialog from '~/components/board/ReviewFrictionDialog.vue'
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
const OperatorDashboardPanel = defineAsyncComponent(
  () => import('~/components/panels/OperatorDashboardPanel.vue'),
)
const ReportsPanel = defineAsyncComponent(() => import('~/components/panels/ReportsPanel.vue'))
const KaizenPanel = defineAsyncComponent(() => import('~/components/kaizen/KaizenPanel.vue'))
// Occasional, externally store-gated surfaces — deferred to their own chunks like the
// sibling document modals above. Each mounts only while its ui open-flag is set, so it
// loads on first open instead of bloating the initial bundle.
const BlockFocusView = defineAsyncComponent(() => import('~/components/focus/BlockFocusView.vue'))
const TaskSourceConnectModal = defineAsyncComponent(
  () => import('~/components/tasks/TaskSourceConnectModal.vue'),
)
const TaskImportModal = defineAsyncComponent(() => import('~/components/tasks/TaskImportModal.vue'))
const BugHuntModal = defineAsyncComponent(() => import('~/components/tasks/BugHuntModal.vue'))
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
const StartFromDesignModal = defineAsyncComponent(
  () => import('~/components/documents/StartFromDesignModal.vue'),
)
const BootstrapModal = defineAsyncComponent(
  () => import('~/components/bootstrap/BootstrapModal.vue'),
)
const AddServiceFromRepoModal = defineAsyncComponent(
  () => import('~/components/github/AddServiceFromRepoModal.vue'),
)
const GitHubPanel = defineAsyncComponent(() => import('~/components/github/GitHubPanel.vue'))
const SlackPanel = defineAsyncComponent(() => import('~/components/slack/SlackPanel.vue'))
const NotificationSettingsPanel = defineAsyncComponent(
  () => import('~/components/notifications/NotificationSettingsPanel.vue'),
)
const FragmentLibraryPanel = defineAsyncComponent(
  () => import('~/components/fragments/FragmentLibraryPanel.vue'),
)
const FoundationalServicePanel = defineAsyncComponent(
  () => import('~/components/foundational/FoundationalServicePanel.vue'),
)
// Startup advisory for invalid / outdated pipelines — only mounted while open (auto-opened
// at most once per session by the watcher below), so it stays out of the initial bundle.
const PipelineHealthModal = defineAsyncComponent(
  () => import('~/components/pipeline/PipelineHealthModal.vue'),
)
// Startup advisory for new / outdated built-in merge presets — same once-per-session pattern.
const RiskPolicyHealthModal = defineAsyncComponent(
  () => import('~/components/settings/RiskPolicyHealthModal.vue'),
)
// Startup advisory for new / outdated built-in model presets — same once-per-session pattern.
const ModelPresetHealthModal = defineAsyncComponent(
  () => import('~/components/settings/ModelPresetHealthModal.vue'),
)
const IntegrationsHub = defineAsyncComponent(
  () => import('~/components/layout/IntegrationsHub.vue'),
)
const ModelProvidersHub = defineAsyncComponent(
  () => import('~/components/layout/ModelProvidersHub.vue'),
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
const ApiTokensPanel = defineAsyncComponent(
  () => import('~/components/settings/ApiTokensPanel.vue'),
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
// The in-app tutorial: the launch prompt (auto-opened once for a user who never answered
// it), the catalogue of every tour the deployment ships (opened from the sidebar's Help
// section or the palette, at any time), the coach-mark overlay that runs a tour, and the
// contextual offer that raises the ONE walkthrough this board just made takeable. All
// mount only while their store flag is set, so they cost the initial bundle nothing.
const TutorialPrompt = defineAsyncComponent(
  () => import('~/components/tutorial/TutorialPrompt.vue'),
)
const TutorialCatalogue = defineAsyncComponent(
  () => import('~/components/tutorial/TutorialCatalogue.vue'),
)
const TutorialOverlay = defineAsyncComponent(
  () => import('~/components/tutorial/TutorialOverlay.vue'),
)
const TutorialNudge = defineAsyncComponent(() => import('~/components/tutorial/TutorialNudge.vue'))
// The first-run role question (Engineer / Product manager / Designer). Same shape as the tutorial
// launch prompt: mounted only while its store flag is set, so an answered question costs nothing.
const RolePrompt = defineAsyncComponent(() => import('~/components/layout/RolePrompt.vue'))

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
  // Consume a run deep link (`?ws=…&block=…&run=…&view=observability`) BEFORE init, so the
  // board it names is the one that opens. This is what makes the observability link on an
  // engine-published PR verification report resolve.
  useRunDeepLink()
  void workspace.init()
  // Honour a `cat-factory k3s` CLI hand-off (`?infraSetup=local-k3s&…`): open the Infrastructure
  // window pre-seeded with the provisioned connection so the user only pastes the token + saves.
  ui.consumeK3sSetupDeepLink()
  // Honour the setup banner's shareable link (`?settings=default-test-env`): open the
  // Infrastructure window on the default test-environment provisioning section.
  ui.consumeDefaultProvisionDeepLink()
})

// Per-session guards so each AI-onboarding dialog auto-opens at most once (later opens are
// user-driven from the banner). Reset on workspace switch by the catalog watcher below.
const autoOpenedSetup = ref(false)
const autoOpenedPreset = ref(false)

// Load the per-workspace model catalog as soon as a board is active (re-loaded per board —
// availability reflects that workspace's keys/subscriptions). This populates the AI-readiness
// signals regardless of which lazy picker happens to mount, so the onboarding prompts below
// can fire. Credential edits re-fetch via `models.refresh()` in the provider panels.
//
// Through `prefetchForBoard` because the FIRST run reads the persisted pin, which `init()` has
// not validated yet: a board that was deleted, or whose access was revoked while the browser
// held the pin, 404s here exactly as it does for init's own speculative snapshot fetch. That
// board is not this watcher's last word (init re-points the pin and it fires again), so the
// miss is dropped rather than left to surface as an uncaught rejection in the page.
watch(
  () => workspace.workspaceId,
  (id, prev) => {
    if (id) void models.prefetchForBoard(id)
    // Switching workspaces resets the per-session AI-onboarding state: dismissals and the
    // auto-open guards are scoped to one workspace, so a prompt dismissed in workspace A must
    // not suppress the (independent) prompt for workspace B that also lacks a usable source.
    if (prev !== undefined && id !== prev) {
      autoOpenedSetup.value = false
      autoOpenedPreset.value = false
      ui.resetAiOnboarding()
      // Infra-setup banner session dismissals are per-workspace too — clear them on switch.
      ui.resetInfraSetupDismissals()
      // Same for the default test-environment prompt: each board records its own choice, so a
      // dismissal on one must not hide the (independent) prompt for another.
      ui.resetDefaultProvisionDismissal()
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
const { hasIssues: riskPolicyIssues } = useRiskPolicyHealth()
watch(
  () => [workspace.ready, riskPolicyIssues.value, ui.pipelineHealthOpen],
  () => {
    if (workspace.ready && riskPolicyIssues.value && !ui.pipelineHealthOpen) {
      ui.maybeOpenRiskPolicyHealth()
    }
  },
  { immediate: true },
)

// Same advisory for built-in model presets: surface new / outdated ones once per session. Defers
// to the pipeline + merge-preset advisories when they fire, so at most one modal auto-opens.
const { hasIssues: modelPresetIssues } = useModelPresetHealth()
watch(
  () => [workspace.ready, modelPresetIssues.value, ui.pipelineHealthOpen, ui.riskPolicyHealthOpen],
  () => {
    if (
      workspace.ready &&
      modelPresetIssues.value &&
      !ui.pipelineHealthOpen &&
      !ui.riskPolicyHealthOpen
    ) {
      ui.maybeOpenModelPresetHealth()
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
// connections are per workspace). The result drives the onboarding gate in the template
// before the board mounts, so an unconnected user can't slip past it. `ensureProbed`
// single-flights per board (app-startup initiative, item 12), so this and the SideBar's
// probe collapse to one request on a cold open instead of two.
watch(
  () => workspace.workspaceId,
  (id) => {
    if (id) void github.ensureProbed()
  },
  { immediate: true },
)

// Hard gate: the App is enabled on the backend but this workspace has no
// installation yet. `available === null` means the probe is still in flight.
// Both are declared here, ahead of the tutorial offer below, because that offer reads them
// from a watcher that runs synchronously during setup (`immediate: true`). Declared after
// it, they'd still be in their TDZ and the first run would throw.
const needsGitHubInstall = computed(() => github.available === true && !github.connected)
const githubProbePending = computed(() => github.available === null)

// Offer the tutorial on launch, once the board is up. Yields to every other startup
// surface — the GitHub onboarding gate, the advisory/onboarding modals above, and the role
// question below — so a first launch never stacks the tour prompt on top of a dialog that
// needs answering first; when one of those is open, the flip of its flag re-fires this
// watcher and the prompt appears then. The store guards the rest: only a user who never
// answered is asked, at most once per session.
//
// Yielding runs in BOTH directions: an advisory that opens LATER (a health probe that
// resolves a beat after the board) would otherwise land on top of an open tour prompt,
// which is the stacking this ordering exists to prevent. So the same watcher withdraws
// an unanswered prompt and re-arms the offer, and the user is asked once the advisory
// they actually have to answer is gone.
//
// The watcher exists only while it can still do something. A saved decision (hydrated
// synchronously from the persisted store) means it never registers, and once a decision
// lands — or the offer has been made and left standing — it stops itself, so the steady
// state pays nothing for the launch offer: no watcher, no mounted component (the v-ifs
// below), no store reads.
const tutorial = useTutorialStore()
const uiRole = useUiRoleStore()
const startupAdvisoryOpen = computed(
  () =>
    needsGitHubInstall.value ||
    githubProbePending.value ||
    ui.pipelineHealthOpen ||
    ui.riskPolicyHealthOpen ||
    ui.modelPresetHealthOpen ||
    ui.aiProviderSetupOpen ||
    ui.aiPresetMismatchOpen,
)

// The ROLE question comes before the tour offer, and the ordering is the point: the role decides
// which surfaces exist, so a tour picked ahead of it could be about half a product the next answer
// removes. It runs the same launch machine as the tutorial offer (yield to anything the user must
// actually answer, re-arm when that surface goes, at most one offer per session) and stops itself
// once it can no longer do anything.
const roleOfferSettled = () => uiRole.chosen || (uiRole.promptAutoOpened && !uiRole.promptOpen)
if (!roleOfferSettled()) {
  let stopRoleOffer: (() => void) | undefined
  stopRoleOffer = watch(
    () => [workspace.ready, startupAdvisoryOpen.value, uiRole.promptOpen],
    () => {
      if (startupAdvisoryOpen.value) uiRole.deferPrompt()
      else if (workspace.ready) uiRole.maybeOfferOnLaunch()
      if (roleOfferSettled()) stopRoleOffer?.()
    },
    { immediate: true },
  )
  if (roleOfferSettled()) stopRoleOffer()
}
// What the TOUR offer yields to: every startup advisory, plus the role question above it. The
// role prompt is not in `startupAdvisoryOpen` itself, or the role offer would defer to its own
// standing offer and withdraw it a tick after making it.
const tutorialYieldsTo = computed(() => startupAdvisoryOpen.value || uiRole.promptOpen)
// Settled = the offer can never need to act again: a decision exists, or the prompt was
// auto-opened and is still standing (a deferral clears `promptAutoOpened`, which is
// exactly what keeps the watcher alive to re-offer).
const tutorialOfferSettled = () =>
  tutorial.decision !== null || (tutorial.promptAutoOpened && !tutorial.promptOpen)
if (!tutorialOfferSettled()) {
  // `let` + optional call: with `immediate: true` the first run happens synchronously
  // inside `watch(...)`, before the handle is assigned — the trailing check covers it.
  let stopTutorialOffer: (() => void) | undefined
  stopTutorialOffer = watch(
    () => [workspace.ready, tutorialYieldsTo.value, tutorial.promptOpen],
    () => {
      if (tutorialYieldsTo.value) tutorial.deferPrompt()
      else if (workspace.ready) tutorial.maybeOfferOnLaunch()
      if (tutorialOfferSettled()) stopTutorialOffer?.()
    },
    { immediate: true },
  )
  if (tutorialOfferSettled()) stopTutorialOffer()
}
// The CONTEXTUAL offer: a different mechanism from the launch one above, so it sits outside that
// watcher's `settled` guard. It has no decision to settle and nothing to defer, because it fires
// on a tour becoming TAKEABLE rather than on the app starting. It reads `workspace.ready` itself
// rather than being gated here, because readiness is not a precondition for CALLING it but the
// definition of its baseline: the gates it watches are board state, so a baseline taken before
// the snapshot lands makes the board's own hydration look like a transition (see `resolveNudge`).
// It honours an explicit decline itself, too (see `newlyAvailableTour`).
useTutorialNudge()
// The mirror to the signed-in user's server row (so progress follows the PERSON, not the browser)
// plus the funnel counters. Unconditional and best-effort: with no accounts or no store wired it
// simply has nothing to talk to, and the browser-persisted store carries on alone.
useTutorialSync()

// Subscribe to the backend's real-time event stream and (re)connect whenever the
// active workspace changes. Runs advance durably server-side; progress arrives as
// pushed events rather than by polling.
const stream = useWorkspaceStream()
// Top-level computed so the template auto-unwraps it (a nested ref read as `stream.connected`
// in the template would not unwrap, since `stream` is a plain object). Drives the headless
// `workspace-stream` readiness marker the e2e suite waits on.
const streamConnected = computed(() => stream.connected.value)
// Final cold-open milestone (app-startup initiative, item 1): a live, reconciled board. `markBoot`
// fires once, so only the first connect of the session times the waterfall's tail.
watch(streamConnected, (c) => c && markBoot('stream-connected'), { immediate: true })
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
  <!-- A COLUMN, so the translation strip below takes its own height instead of covering the
       row: page chrome that overlays the app is how the board's top controls came to be
       buried. Everything else lives in the row beneath it. -->
  <div class="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
    <!-- Non-English locale warning (unofficial translation); slim full-width strip above
         everything, in flow. -->
    <TranslationWarningBanner />
    <div class="relative flex min-h-0 flex-1">
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
          <!-- Toolbar, nav trigger and every advisory banner, in ONE stacked region that owns
               their placement, so no two of them can cover each other. -->
          <BoardTopOverlays
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
        <!-- Consumer-contributed top-level overlays (extension slice D). Renders nothing until a
             consumer opens one via `ui.openOverlay` / `useAppOverlays().open(...)`. -->
        <AppOverlayHost />
        <AddTaskModal />
        <ReviewFrictionDialog v-if="ui.reviewFrictionContext" />
        <CreateInitiativeModal />
        <CommandBar />
        <PersonalCredentialModal />
        <ConfirmDialog />
        <KeyboardShortcutsHelp />

        <!-- Lazy panels: mounted only while their ui open-flag is set, so each loads on
             first open (its own chunk) rather than bloating the initial bundle. -->
        <TaskSourceConnectModal v-if="ui.taskConnect" />
        <TaskImportModal v-if="ui.taskImport" />
        <BugHuntModal v-if="ui.bugHunt" />
        <RecurringPipelineModal v-if="ui.addRecurringFrameId" />
        <ObservabilityPanel v-if="ui.observabilityInstanceId" />
        <OperatorDashboardPanel v-if="ui.operatorDashboardOpen" />
        <ReportsPanel v-if="ui.reportsOpen" />
        <KaizenPanel v-if="ui.kaizenScreenOpen" />
        <DocumentSourceConnectModal v-if="ui.documentConnect" />
        <DocumentImportModal v-if="ui.documentImport" />
        <DocumentTemplatesModal v-if="ui.documentTemplates" />
        <SpawnPreviewModal v-if="ui.spawnPreview" />
        <StartFromDesignModal v-if="ui.startFromDesign" />
        <BootstrapModal v-if="ui.bootstrapOpen" />
        <AddServiceFromRepoModal v-if="ui.addServiceOpen" />
        <GitHubPanel v-if="ui.githubOpen" />
        <SlackPanel v-if="ui.slackOpen" />
        <NotificationSettingsPanel v-if="ui.notificationSettingsOpen" />
        <FragmentLibraryPanel v-if="ui.fragmentLibraryOpen" />
        <FoundationalServicePanel v-if="ui.foundationalServicesOpen" />
        <PipelineHealthModal v-if="ui.pipelineHealthOpen" />
        <RiskPolicyHealthModal v-if="ui.riskPolicyHealthOpen" />
        <ModelPresetHealthModal v-if="ui.modelPresetHealthOpen" />
        <IntegrationsHub v-if="ui.integrationsOpen" />
        <ModelProvidersHub v-if="ui.modelProvidersOpen" />
        <PersonalSetupModal v-if="ui.personalSetupOpen" />
        <WorkspaceSettingsPanel v-if="ui.workspaceSettingsOpen" />
        <AccountSettingsPanel v-if="ui.accountSettingsOpen" />
        <ObservabilityConnectionPanel v-if="ui.observabilityConnectionOpen" />
        <ApiTokensPanel v-if="ui.apiTokensOpen" />
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
        <RolePrompt v-if="uiRole.promptOpen" />
        <TutorialPrompt v-if="tutorial.promptOpen" />
        <TutorialCatalogue v-if="tutorial.catalogueOpen" />
        <TutorialOverlay v-if="tutorial.touring" />
        <!-- Mounted off the PENDING id rather than off whether it may currently be SHOWN: the
             component holds a suppressed offer (a tour is running, a tutorial window is open) and
             renders it once the way is clear, which is the whole reason the offer survives the
             moment it was raised in. -->
        <TutorialNudge v-if="tutorial.pendingNudgeId" />
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
  </div>
</template>
