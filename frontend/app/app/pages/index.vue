<script setup lang="ts">
import BoardCanvas from '~/components/board/BoardCanvas.vue'
import SideBar from '~/components/layout/SideBar.vue'
import BoardToolbar from '~/components/layout/BoardToolbar.vue'
import SpendWarningBanner from '~/components/layout/SpendWarningBanner.vue'
import PipelineBuilder from '~/components/pipeline/PipelineBuilder.vue'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import DecisionModal from '~/components/panels/DecisionModal.vue'
import BlockFocusView from '~/components/focus/BlockFocusView.vue'
import DocumentSourceConnectModal from '~/components/documents/DocumentSourceConnectModal.vue'
import DocumentImportModal from '~/components/documents/DocumentImportModal.vue'
import SpawnPreviewModal from '~/components/documents/SpawnPreviewModal.vue'
import TaskSourceConnectModal from '~/components/tasks/TaskSourceConnectModal.vue'
import TaskImportModal from '~/components/tasks/TaskImportModal.vue'
import AddTaskModal from '~/components/board/AddTaskModal.vue'
import BootstrapModal from '~/components/bootstrap/BootstrapModal.vue'
import AddServiceFromRepoModal from '~/components/github/AddServiceFromRepoModal.vue'
import GitHubPanel from '~/components/github/GitHubPanel.vue'
import FragmentLibraryPanel from '~/components/fragments/FragmentLibraryPanel.vue'
import RequirementReviewModal from '~/components/requirements/RequirementReviewModal.vue'

const workspace = useWorkspaceStore()

// Load the board from the backend before rendering it.
onMounted(() => workspace.init())

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
    <template v-if="workspace.ready">
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
      <DocumentSourceConnectModal />
      <DocumentImportModal />
      <SpawnPreviewModal />
      <TaskSourceConnectModal />
      <TaskImportModal />
      <AddTaskModal />
      <BootstrapModal />
      <AddServiceFromRepoModal />
      <GitHubPanel />
      <FragmentLibraryPanel />
      <RequirementReviewModal />
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
