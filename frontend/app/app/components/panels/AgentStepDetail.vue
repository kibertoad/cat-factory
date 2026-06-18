<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { AgentState } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'
import { parseOutputOutline } from '~/utils/agentOutput'

// Detail overlay for a single pipeline step. Opened by clicking an agent in the
// inspector list (TaskExecution) or the focus-view pipeline (PipelineProgress) via
// `ui.openStepDetail(instanceId, stepIndex)`. It resolves the step from the
// execution store so it stays live while open, and shows the step's metadata
// (state, timing, model, subtasks, fragments, decision/approval). When the agent
// produced prose (architect, researcher, reviewer, …) it also renders that output
// as markdown, split into collapsible sections with an auto-generated ToC sidebar.
const ui = useUiStore()
const execution = useExecutionStore()
const board = useBoardStore()
const models = useModelsStore()

onMounted(() => models.ensureLoaded())

const ctx = computed(() => ui.stepDetail)
const instance = computed(() => execution.getInstance(ctx.value?.instanceId))
const step = computed(() =>
  ctx.value ? (instance.value?.steps[ctx.value.stepIndex] ?? null) : null,
)
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))
const agent = computed(() => (step.value ? AGENT_BY_KIND[step.value.agentKind] : null))
const open = computed(() => !!ctx.value && !!step.value)

const stepNumber = computed(() => (ctx.value ? ctx.value.stepIndex + 1 : 0))
const totalSteps = computed(() => instance.value?.steps.length ?? 0)

const STATE_META: Record<AgentState, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#64748b' },
  working: { label: 'Working', color: '#6366f1' },
  waiting_decision: { label: 'Needs input', color: '#f59e0b' },
  done: { label: 'Done', color: '#22c55e' },
}

// A 1s tick so a still-running step's elapsed time counts up live while open.
const nowTick = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nowTick.value = Date.now()
  timer = setInterval(() => (nowTick.value = Date.now()), 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const isRunning = computed(() => !!step.value?.startedAt && !step.value?.finishedAt)
/** Elapsed/total execution time in ms — null until the step has started. */
const durationMs = computed(() => {
  const s = step.value
  if (s?.startedAt == null) return null
  const end = s.finishedAt ?? nowTick.value
  return Math.max(0, end - s.startedAt)
})

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  const h = Math.floor(m / 60)
  const min = m % 60
  return min ? `${h}h ${min}m` : `${h}h`
}
function formatClock(ms?: number | null): string | null {
  return ms ? new Date(ms).toLocaleString() : null
}

const durationLabel = computed(() =>
  durationMs.value == null ? null : formatDuration(durationMs.value),
)
const modelLabel = computed(() => (step.value?.model ? models.labelForRef(step.value.model) : null))

const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}

// --- prose reader (only when the step produced output) -----------------------
const outline = computed(() => parseOutputOutline(step.value?.output ?? ''))
const tocSections = computed(() => outline.value.sections.filter((s) => s.depth > 0))
const hasOutput = computed(() => !!step.value?.output?.trim())

const collapsed = reactive<Record<string, boolean>>({})
const activeId = ref<string>('step-details')
const scrollEl = ref<HTMLElement | null>(null)
const sectionEls = reactive<Record<string, HTMLElement | null>>({})

// Anchors the ToC navigates + the scroll-spy tracks: the details card first, then
// every heading section of the prose.
const anchors = computed(() => ['step-details', ...tocSections.value.map((s) => s.id)])

// Re-seed (all sections expanded, scrolled to top) whenever a different step opens.
watch(
  () => ctx.value && `${ctx.value.instanceId}:${ctx.value.stepIndex}`,
  (key) => {
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    activeId.value = 'step-details'
    if (key) void nextTick(() => scrollEl.value?.scrollTo({ top: 0 }))
  },
)

function close() {
  ui.closeStepDetail()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})

function toggle(id: string) {
  collapsed[id] = !collapsed[id]
}
function setAll(value: boolean) {
  for (const s of outline.value.sections) collapsed[s.id] = value
}
const allCollapsed = computed(
  () => outline.value.sections.length > 0 && outline.value.sections.every((s) => collapsed[s.id]),
)

async function goTo(id: string) {
  if (collapsed[id]) collapsed[id] = false
  activeId.value = id
  await nextTick()
  sectionEls[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onScroll() {
  const container = scrollEl.value
  if (!container) return
  const line = container.getBoundingClientRect().top + 80
  let current = anchors.value[0] ?? 'step-details'
  for (const id of anchors.value) {
    const el = sectionEls[id]
    if (el && el.getBoundingClientRect().top <= line) current = id
    else break
  }
  activeId.value = current
}

async function copyOutput() {
  if (step.value?.output) await navigator.clipboard?.writeText(step.value.output)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="reader-fade">
      <div
        v-if="open && step && agent"
        class="fixed inset-0 z-50 flex bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <!-- ToC sidebar (only meaningful when there are prose headings) -->
        <aside
          v-if="outline.hasToc"
          class="hidden w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 md:flex"
        >
          <div class="border-b border-slate-800 px-4 py-3">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Contents
            </div>
          </div>
          <nav class="flex-1 space-y-0.5 overflow-auto px-2 py-3">
            <button
              class="block w-full truncate rounded-md px-2 py-1 text-left text-[13px] transition"
              :class="
                activeId === 'step-details'
                  ? 'bg-indigo-500/15 font-medium text-indigo-200'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              "
              @click="goTo('step-details')"
            >
              Details
            </button>
            <button
              v-for="s in tocSections"
              :key="s.id"
              class="block w-full truncate rounded-md px-2 py-1 text-left text-[13px] transition"
              :class="
                activeId === s.id
                  ? 'bg-indigo-500/15 font-medium text-indigo-200'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              "
              :style="{ paddingLeft: `${(s.depth - outline.minDepth) * 0.85 + 0.5}rem` }"
              :title="s.title"
              @click="goTo(s.id)"
            >
              {{ s.title }}
            </button>
          </nav>
        </aside>

        <!-- main column -->
        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
            <div
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              :style="{ backgroundColor: agent.color + '22' }"
            >
              <UIcon :name="agent.icon" class="h-5 w-5" :style="{ color: agent.color }" />
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold text-white">{{ agent.label }}</h1>
              <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
            </div>
            <div class="ml-auto flex items-center gap-1.5">
              <UButton
                v-if="outline.sections.length"
                :icon="allCollapsed ? 'i-lucide-unfold-vertical' : 'i-lucide-fold-vertical'"
                color="neutral"
                variant="ghost"
                size="sm"
                :title="allCollapsed ? 'Expand all sections' : 'Collapse all sections'"
                @click="setAll(!allCollapsed)"
              />
              <UButton
                v-if="hasOutput"
                icon="i-lucide-copy"
                color="neutral"
                variant="ghost"
                size="sm"
                title="Copy raw output"
                @click="copyOutput"
              />
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="sm"
                title="Close (Esc)"
                @click="close"
              />
            </div>
          </header>

          <div ref="scrollEl" class="flex-1 overflow-auto px-6 py-6" @scroll="onScroll">
            <div class="mx-auto max-w-3xl space-y-5">
              <!-- metadata card (always shown) -->
              <section
                id="step-details"
                :ref="(el) => (sectionEls['step-details'] = el as HTMLElement | null)"
                class="scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">State</dt>
                    <dd class="mt-0.5 flex items-center gap-1.5 text-slate-200">
                      <span
                        class="h-2 w-2 rounded-full"
                        :style="{ backgroundColor: STATE_META[step.state].color }"
                      />
                      {{ STATE_META[step.state].label }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Duration</dt>
                    <dd class="mt-0.5 flex items-center gap-1.5 tabular-nums text-slate-200">
                      <UIcon
                        v-if="isRunning"
                        name="i-lucide-loader-circle"
                        class="h-3 w-3 animate-spin text-indigo-400"
                      />
                      <span v-if="durationLabel">{{ durationLabel }}</span>
                      <span v-else class="text-slate-500">—</span>
                      <span v-if="isRunning" class="text-[11px] text-slate-500">elapsed</span>
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Step</dt>
                    <dd class="mt-0.5 text-slate-200">{{ stepNumber }} of {{ totalSteps }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Started</dt>
                    <dd class="mt-0.5 text-slate-300">{{ formatClock(step.startedAt) ?? '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Finished</dt>
                    <dd class="mt-0.5 text-slate-300">{{ formatClock(step.finishedAt) ?? '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Model</dt>
                    <dd class="mt-0.5 truncate text-slate-300" :title="step.model">
                      {{ modelLabel ?? 'Not recorded' }}
                    </dd>
                  </div>
                </dl>

                <!-- live subtask breakdown -->
                <div v-if="step.subtasks && step.subtasks.total > 0" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Subtasks · {{ step.subtasks.completed }}/{{ step.subtasks.total }}
                  </div>
                  <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
                    <div
                      class="h-full rounded-full bg-indigo-400 transition-all duration-500"
                      :style="{
                        width: `${(step.subtasks.completed / step.subtasks.total) * 100}%`,
                      }"
                    />
                  </div>
                  <ul v-if="step.subtasks.items?.length" class="mt-2 space-y-1">
                    <li
                      v-for="(item, idx) in step.subtasks.items"
                      :key="idx"
                      class="flex items-start gap-1.5 text-[12px]"
                      :class="
                        item.status === 'completed'
                          ? 'text-slate-500 line-through'
                          : item.status === 'in_progress'
                            ? 'text-slate-100'
                            : 'text-slate-400'
                      "
                    >
                      <UIcon
                        :name="ITEM_ICON[item.status]"
                        class="mt-px h-3 w-3 shrink-0"
                        :class="[
                          item.status === 'in_progress' ? 'animate-spin text-indigo-400' : '',
                          item.status === 'completed' ? 'text-emerald-400' : 'text-slate-500',
                        ]"
                      />
                      <span>{{ item.label }}</span>
                    </li>
                  </ul>
                </div>

                <!-- standards (prompt fragments) folded into this step -->
                <div
                  v-if="step.selectedFragmentIds && step.selectedFragmentIds.length"
                  class="mt-4"
                >
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Standards applied
                  </div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <UBadge
                      v-for="id in step.selectedFragmentIds"
                      :key="id"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    >
                      {{ id }}
                    </UBadge>
                  </div>
                </div>

                <!-- decision raised on this step -->
                <div v-if="step.decision" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">Decision</div>
                  <p class="mt-0.5 text-[13px] text-slate-200">{{ step.decision.question }}</p>
                  <p
                    v-if="step.decision.chosen"
                    class="mt-0.5 flex items-center gap-1 text-[12px] text-emerald-400"
                  >
                    <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
                    {{ step.decision.chosen }}
                  </p>
                  <p v-else class="mt-0.5 text-[12px] text-amber-400">Awaiting a human choice</p>
                </div>

                <!-- approval gate state -->
                <div v-if="step.approval" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Approval gate
                  </div>
                  <p class="mt-0.5 text-[13px] text-slate-200 capitalize">
                    {{ step.approval.status.replace('_', ' ') }}
                  </p>
                </div>
              </section>

              <!-- the agent's prose output, sectioned + collapsible -->
              <template v-if="hasOutput">
                <section
                  v-for="s in outline.sections"
                  :id="s.id"
                  :key="s.id"
                  :ref="(el) => (sectionEls[s.id] = el as HTMLElement | null)"
                  class="scroll-mt-4"
                >
                  <button
                    v-if="s.depth > 0"
                    class="group flex w-full items-center gap-2 rounded-md py-1 text-left transition hover:text-white"
                    @click="toggle(s.id)"
                  >
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-hover:text-slate-300"
                      :class="collapsed[s.id] ? '' : 'rotate-90'"
                    />
                    <span
                      class="font-semibold text-slate-100"
                      :class="s.depth <= 1 ? 'text-lg' : s.depth === 2 ? 'text-base' : 'text-sm'"
                      v-html="s.titleHtml"
                    />
                  </button>
                  <div
                    v-show="!collapsed[s.id]"
                    class="reader-prose mt-1 text-[13px] leading-relaxed text-slate-300"
                    :class="s.depth > 0 ? 'pl-6' : ''"
                    v-html="s.bodyHtml"
                  />
                </section>
              </template>

              <p
                v-else
                class="rounded-lg border border-dashed border-slate-800 py-6 text-center text-sm text-slate-500"
              >
                This agent produced no prose output.
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}

/* Styling for the markdown HTML injected via v-html (out of scoped reach without
   :deep), kept close to the inspector's existing prose styling. */
.reader-prose :deep(p) {
  margin: 0.5rem 0;
}
.reader-prose :deep(ul),
.reader-prose :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.reader-prose :deep(ul) {
  list-style: disc;
}
.reader-prose :deep(ol) {
  list-style: decimal;
}
.reader-prose :deep(li) {
  margin: 0.2rem 0;
}
.reader-prose :deep(strong) {
  font-weight: 600;
  color: rgb(226 232 240);
}
.reader-prose :deep(em) {
  font-style: italic;
}
.reader-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(30 41 59 / 0.8);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  color: rgb(199 210 254);
}
.reader-prose :deep(pre) {
  margin: 0.6rem 0;
  overflow: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem 0.9rem;
}
.reader-prose :deep(pre code) {
  background: transparent;
  padding: 0;
  color: rgb(203 213 225);
}
.reader-prose :deep(blockquote) {
  margin: 0.6rem 0;
  border-left: 3px solid rgb(99 102 241 / 0.5);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
.reader-prose :deep(table) {
  margin: 0.6rem 0;
  border-collapse: collapse;
  font-size: 0.95em;
}
.reader-prose :deep(th),
.reader-prose :deep(td) {
  border: 1px solid rgb(51 65 85);
  padding: 0.3rem 0.6rem;
}
.reader-prose :deep(th) {
  background: rgb(30 41 59 / 0.6);
  font-weight: 600;
}
.reader-prose :deep(hr) {
  margin: 1rem 0;
  border: none;
  border-top: 1px solid rgb(51 65 85);
}
.reader-prose :deep(h1),
.reader-prose :deep(h2),
.reader-prose :deep(h3),
.reader-prose :deep(h4) {
  margin: 0.6rem 0 0.3rem;
  font-weight: 600;
  color: rgb(226 232 240);
}
</style>
