<script setup lang="ts">
import type { Block, BlockStatus } from '~/types/domain'
import { AGENT_BY_KIND, BLOCK_TYPE_META, STATUS_META, DEFAULT_CONFIDENCE_THRESHOLD } from '~/utils/catalog'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const toast = useToast()

function placeholder(what: string) {
  toast.add({ title: 'Placeholder', description: what, icon: 'i-lucide-construction' })
}

const block = computed<Block | undefined>(() =>
  ui.selectedBlockId ? board.getBlock(ui.selectedBlockId) : undefined,
)
const level = computed(() => block.value?.level ?? 'frame')
const isFrame = computed(() => level.value === 'frame')
const isModule = computed(() => level.value === 'module')
const isContainer = computed(() => isFrame.value || isModule.value)
const isTask = computed(() => level.value === 'task')

const instance = computed(() => execution.getInstance(block.value?.executionId))
const typeMeta = computed(() => (block.value ? BLOCK_TYPE_META[block.value.type] : null))

// Containers show a derived activity status (never "done"); tasks use their own.
const FRAME_LABEL: Record<BlockStatus, string> = {
  planned: 'No tasks',
  ready: 'Live',
  in_progress: 'Active',
  blocked: 'Needs attention',
  pr_ready: 'Active',
  done: 'Live',
}
const effectiveStatus = computed<BlockStatus>(() =>
  isContainer.value ? board.frameStatus(block.value!.id) : block.value!.status,
)
const statusMeta = computed(() => (block.value ? STATUS_META[effectiveStatus.value] : null))
const statusLabel = computed(() =>
  isContainer.value ? FRAME_LABEL[effectiveStatus.value] : statusMeta.value!.label,
)

// ---- container: child tasks (service = all nested; module = direct) --------
const tasks = computed(() => {
  if (!block.value) return []
  if (isFrame.value) return board.allTasksUnder(block.value.id)
  if (isModule.value) return board.tasksOf(block.value.id)
  return []
})
const modules = computed(() =>
  isFrame.value && block.value ? board.modulesOf(block.value.id) : [],
)

// ---- task: structural properties (module assignment + features) ------------
const newFeature = ref('')
function addFeature() {
  const v = newFeature.value.trim()
  if (!v || !block.value) return
  const list = block.value.features ? [...block.value.features] : []
  if (!list.includes(v)) list.push(v)
  board.updateBlock(block.value.id, { features: list })
  newFeature.value = ''
}
function removeFeature(f: string) {
  if (!block.value?.features) return
  board.updateBlock(block.value.id, { features: block.value.features.filter((x) => x !== f) })
}

// ---- task: dependencies (cross-frame) --------------------------------------
const deps = computed(() =>
  (block.value?.dependsOn ?? [])
    .map((id) => board.getBlock(id))
    .filter((b): b is Block => !!b),
)
const runnable = computed(() => (block.value ? board.isRunnable(block.value.id) : false))

function frameTitle(b: Block) {
  return b.parentId ? board.getBlock(b.parentId)?.title : undefined
}
function depLabel(dep: Block) {
  const f = frameTitle(dep)
  return f && dep.parentId !== block.value?.parentId ? `${f} / ${dep.title}` : dep.title
}

// candidate tasks to depend on: any other task not already a dependency
const depMenu = computed(() => {
  if (!isTask.value || !block.value) return []
  const current = new Set(block.value.dependsOn)
  return board.allTasks
    .filter((t) => t.id !== block.value!.id && !current.has(t.id))
    .map((t) => ({
      label: depLabel(t),
      icon: 'i-lucide-plus',
      onSelect: () => board.toggleDependency(block.value!.id, t.id),
    }))
})

function removeDep(depId: string) {
  if (block.value) board.removeDependency(block.value.id, depId)
}

// threshold editing (percent <-> 0..1)
const thresholdPct = computed({
  get: () => Math.round((block.value?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD) * 100),
  set: (v: number) => {
    if (block.value) board.updateBlock(block.value.id, { confidenceThreshold: Math.min(100, Math.max(0, v)) / 100 })
  },
})
const confidencePct = computed(() =>
  block.value?.confidence != null ? Math.round(block.value.confidence * 100) : null,
)

const runMenu = computed(() =>
  pipelines.pipelines.map((p) => ({
    label: p.name,
    icon: 'i-lucide-play',
    onSelect: () => block.value && execution.start(block.value.id, p),
  })),
)

const stepLabel: Record<string, string> = {
  pending: 'Pending',
  working: 'Working',
  waiting_decision: 'Needs decision',
  done: 'Done',
}

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
}

function addTask() {
  if (block.value) board.addTask(block.value.id)
}

function remove() {
  if (!block.value) return
  execution.cancel(block.value.id)
  board.removeBlock(block.value.id)
  ui.select(null)
}
</script>

<template>
  <div
    v-if="block && statusMeta && typeMeta"
    class="absolute right-4 top-4 z-20 w-80 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur"
  >
    <div class="h-1.5 w-full" :style="{ backgroundColor: statusMeta.color }" />
    <div class="space-y-4 p-4">
      <!-- header -->
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2">
          <div
            class="flex h-9 w-9 items-center justify-center rounded-lg"
            :style="{ backgroundColor: typeMeta.accent + '22' }"
          >
            <UIcon :name="typeMeta.icon" class="h-5 w-5" :style="{ color: typeMeta.accent }" />
          </div>
          <div>
            <div class="text-sm font-semibold text-white">{{ block.title }}</div>
            <div class="mt-0.5 flex items-center gap-1.5">
              <UBadge :color="statusMeta.chip as any" variant="subtle" size="sm">
                {{ statusLabel }}
              </UBadge>
              <span class="text-[10px] uppercase tracking-wide text-slate-500">{{ level }}</span>
            </div>
          </div>
        </div>
        <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" @click="ui.select(null)" />
      </div>

      <UTextarea
        v-model="block.description"
        :rows="2"
        autoresize
        size="sm"
        class="w-full"
        placeholder="Describe this block…"
      />

      <!-- external links (placeholder integrations) -->
      <div class="flex flex-wrap gap-2">
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-ticket" @click="placeholder('Link JIRA ticket')">
          Link JIRA ticket
        </UButton>
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-file-text" @click="placeholder('Link context documents')">
          Link context documents
        </UButton>
      </div>

      <!-- ============ SERVICE / MODULE: tasks summary ============ -->
      <template v-if="isContainer">
        <!-- modules (services only) -->
        <div v-if="modules.length">
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Modules ({{ modules.length }})
          </div>
          <ul class="space-y-1">
            <li
              v-for="m in modules"
              :key="m.id"
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-800/60"
              @click="ui.select(m.id)"
            >
              <UIcon name="i-lucide-package" class="h-3.5 w-3.5 text-violet-400" />
              <span class="truncate text-xs text-slate-200">{{ m.title }}</span>
              <span class="ml-auto text-[10px] text-slate-500">{{ board.tasksOf(m.id).length }} task(s)</span>
            </li>
          </ul>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ isFrame ? 'All tasks' : 'Tasks' }} ({{ tasks.length }})
            </span>
            <UButton size="xs" variant="soft" color="primary" icon="i-lucide-plus" @click="addTask">
              Add task
            </UButton>
          </div>
          <ul v-if="tasks.length" class="space-y-1">
            <li
              v-for="t in tasks"
              :key="t.id"
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-800/60"
              @click="ui.select(t.id)"
            >
              <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: STATUS_META[t.status].color }" />
              <span class="truncate text-xs text-slate-200">{{ t.title }}</span>
              <span class="ml-auto text-[10px] text-slate-500">{{ STATUS_META[t.status].label }}</span>
            </li>
          </ul>
          <div v-else class="text-[11px] text-slate-500">No tasks yet — add one to start work.</div>
        </div>
        <p v-if="isFrame" class="text-[11px] text-slate-500">
          Services are long-lived — they don't "complete". Work happens in their tasks &amp; modules.
        </p>
      </template>

      <!-- ============ TASK: dependencies + run/merge ============ -->
      <template v-else-if="isTask">
        <!-- dependencies -->
        <div>
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Depends on
            </span>
            <UDropdownMenu v-if="depMenu.length" :items="depMenu">
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-plus" trailing-icon="i-lucide-chevron-down" />
            </UDropdownMenu>
          </div>
          <div v-if="deps.length" class="flex flex-wrap gap-1">
            <UBadge
              v-for="d in deps"
              :key="d.id"
              :color="d.status === 'done' ? 'neutral' : 'warning'"
              variant="subtle"
              size="sm"
              class="cursor-pointer"
              :title="d.status === 'done' ? 'Merged' : 'Not merged yet'"
              @click="removeDep(d.id)"
            >
              {{ depLabel(d) }}
              <UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
            </UBadge>
          </div>
          <div v-else class="text-[11px] text-slate-500">No dependencies — can run any time.</div>
          <div v-if="!runnable" class="mt-1 text-[10px] text-amber-400">
            Blocked until dependencies merge.
          </div>
        </div>

        <!-- module assignment -->
        <div>
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Module
          </div>
          <UInput
            v-model="block.moduleName"
            size="sm"
            class="w-full"
            placeholder="e.g. Sessions (created on implement if new)"
            icon="i-lucide-package"
          />
        </div>

        <!-- features implemented -->
        <div>
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Features implemented
          </div>
          <div v-if="block.features?.length" class="mb-1 flex flex-wrap gap-1">
            <UBadge
              v-for="f in block.features"
              :key="f"
              color="success"
              variant="subtle"
              size="sm"
              class="cursor-pointer"
              @click="removeFeature(f)"
            >
              {{ f }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
            </UBadge>
          </div>
          <UInput
            v-model="newFeature"
            size="sm"
            class="w-full"
            placeholder="Add a feature, press Enter"
            icon="i-lucide-puzzle"
            @keydown.enter="addFeature"
          />
        </div>

        <!-- confidence threshold -->
        <div>
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Auto-merge threshold
          </div>
          <div class="flex items-center gap-2">
            <UInput v-model.number="thresholdPct" type="number" min="0" max="100" size="sm" class="w-20" />
            <span class="text-[11px] text-slate-400">% confidence</span>
          </div>
          <div v-if="confidencePct != null" class="mt-1 text-[11px]">
            Last run scored
            <span :class="block.confidence! >= (block.confidenceThreshold ?? 0.8) ? 'text-emerald-400' : 'text-amber-400'">
              {{ confidencePct }}%
            </span>
          </div>
        </div>

        <!-- running pipeline -->
        <div v-if="instance">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ instance.pipelineName }}
            </span>
            <UButton icon="i-lucide-square" color="error" variant="ghost" size="xs" @click="execution.cancel(block.id)">
              Stop
            </UButton>
          </div>
          <ul class="space-y-1">
            <li
              v-for="(s, i) in instance.steps"
              :key="i"
              class="flex items-center gap-2 rounded-md px-2 py-1"
              :class="i === instance.currentStep ? 'bg-slate-800/70' : ''"
            >
              <UIcon :name="AGENT_BY_KIND[s.agentKind].icon" class="h-4 w-4" :style="{ color: AGENT_BY_KIND[s.agentKind].color }" />
              <span class="text-xs text-slate-200">{{ AGENT_BY_KIND[s.agentKind].label }}</span>
              <span class="ml-auto text-[10px] text-slate-400">{{ stepLabel[s.state] }}</span>
              <UButton
                v-if="s.decision && !s.decision.chosen"
                color="warning"
                variant="soft"
                size="xs"
                icon="i-lucide-circle-help"
                @click="openDecisionFor(s.decision.id)"
              >
                Resolve
              </UButton>
            </li>
          </ul>
        </div>

        <!-- PR ready: review / merge -->
        <UButton
          v-if="block.status === 'pr_ready'"
          color="success"
          variant="solid"
          size="sm"
          icon="i-lucide-git-merge"
          block
          @click="execution.mergePr(block.id)"
        >
          Merge PR
        </UButton>
      </template>

      <!-- ============ actions ============ -->
      <div class="flex items-center gap-2">
        <UDropdownMenu v-if="isTask" :items="runMenu">
          <UButton
            :color="runnable ? 'primary' : 'neutral'"
            variant="soft"
            size="sm"
            :icon="runnable ? 'i-lucide-play' : 'i-lucide-lock'"
            trailing-icon="i-lucide-chevron-down"
            :disabled="!runnable"
          >
            {{ instance ? 'Re-run' : 'Run' }}
          </UButton>
        </UDropdownMenu>
        <UButton v-if="isTask" color="neutral" variant="soft" size="sm" icon="i-lucide-maximize-2" @click="ui.focus(block.id)">
          Focus
        </UButton>
        <UButton color="error" variant="ghost" size="sm" icon="i-lucide-trash-2" class="ml-auto" @click="remove" />
      </div>
    </div>
  </div>
</template>
