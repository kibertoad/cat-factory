<script setup lang="ts">
import BoardCanvas from '~/components/board/BoardCanvas.vue'
import SideBar from '~/components/layout/SideBar.vue'
import BoardToolbar from '~/components/layout/BoardToolbar.vue'
import SpendWarningBanner from '~/components/layout/SpendWarningBanner.vue'
import PipelineBuilder from '~/components/pipeline/PipelineBuilder.vue'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import DecisionModal from '~/components/panels/DecisionModal.vue'
import AgentStepDetail from '~/components/panels/AgentStepDetail.vue'
import ObservabilityPanel from '~/components/panels/ObservabilityPanel.vue'
import BlockFocusView from '~/components/focus/BlockFocusView.vue'
import DocumentSourceConnectModal from '~/components/documents/DocumentSourceConnectModal.vue'
import DocumentImportModal from '~/components/documents/DocumentImportModal.vue'
import SpawnPreviewModal from '~/components/documents/SpawnPreviewModal.vue'
import TaskSourceConnectModal from '~/components/tasks/TaskSourceConnectModal.vue'
import TaskImportModal from '~/components/tasks/TaskImportModal.vue'
import AddTaskModal from '~/components/board/AddTaskModal.vue'
import RecurringPipelineModal from '~/components/board/RecurringPipelineModal.vue'
import BootstrapModal from '~/components/bootstrap/BootstrapModal.vue'
import AddServiceFromRepoModal from '~/components/github/AddServiceFromRepoModal.vue'
import GitHubPanel from '~/components/github/GitHubPanel.vue'
import SlackPanel from '~/components/slack/SlackPanel.vue'
import GitHubOnboarding from '~/components/github/GitHubOnboarding.vue'
import FragmentLibraryPanel from '~/components/fragments/FragmentLibraryPanel.vue'
import CommandBar from '~/components/layout/CommandBar.vue'
import MergeThresholdsPanel from '~/components/settings/MergeThresholdsPanel.vue'
import ModelDefaultsPanel from '~/components/settings/ModelDefaultsPanel.vue'
import ServiceFragmentDefaultsPanel from '~/components/settings/ServiceFragmentDefaultsPanel.vue'

const workspace = useWorkspaceStore()
const github = useGitHubStore()

// Load the board from the backend before rendering it.
onMounted(() => workspace.init())

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

      <PipelineBuilder />
      <DecisionModal />
      <AgentStepDetail />
      <StepResultViewHost />
      <ObservabilityPanel />
      <DocumentSourceConnectModal />
      <DocumentImportModal />
      <SpawnPreviewModal />
      <TaskSourceConnectModal />
      <TaskImportModal />
      <AddTaskModal />
      <RecurringPipelineModal />
      <BootstrapModal />
      <AddServiceFromRepoModal />
      <GitHubPanel />
      <SlackPanel />
      <FragmentLibraryPanel />
      <CommandBar />
      <MergeThresholdsPanel />
      <ModelDefaultsPanel />
      <ServiceFragmentDefaultsPanel />
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
