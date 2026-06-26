<script setup lang="ts">
import { computed, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { KaizenGrading } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'

// The Kaizen screen: a full-panel overlay listing the workspace's grading history and
// its verified-combo library. Opened via `ui.openKaizen()` from the sidebar. Read-only —
// grading is scheduled by the engine and run by the background sweep, never from here.
const ui = useUiStore()
const kaizen = useKaizenStore()

const open = computed(() => ui.kaizenScreenOpen)

watch(open, (isOpen) => {
  if (isOpen) void kaizen.loadOverview()
})

function close() {
  ui.closeKaizen()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})

function meta(kind: string) {
  return agentKindMeta(kind)
}
function when(ms: number): string {
  return new Date(ms).toLocaleString()
}
function gradeTone(g: KaizenGrading): string {
  if (g.status === 'failed') return 'text-slate-500'
  if (g.grade == null) return 'text-slate-400'
  if (g.grade >= 5) return 'text-emerald-400'
  if (g.grade >= 4) return 'text-lime-400'
  if (g.grade === 3) return 'text-amber-400'
  return 'text-rose-400'
}
function statusLabel(g: KaizenGrading): string {
  if (g.status === 'scheduled') return 'Scheduled'
  if (g.status === 'running') return 'Grading…'
  if (g.status === 'failed') return 'Failed'
  return g.grade != null ? `${g.grade}/5` : 'Graded'
}
</script>

<template>
  <Teleport to="body">
    <Transition name="kz-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/15">
            <UIcon name="i-lucide-sparkles" class="h-5 w-5 text-teal-400" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">Kaizen</h1>
            <p class="truncate text-xs text-slate-500">
              Continuous-improvement grading of agent runs
            </p>
          </div>
          <div class="ml-auto flex items-center gap-2">
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="kaizen.loadingOverview"
              @click="kaizen.loadOverview()"
            >
              Refresh
            </UButton>
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="close">
              Close
            </UButton>
          </div>
        </header>

        <div
          v-if="kaizen.available === false"
          class="flex flex-1 items-center justify-center text-sm text-slate-500"
        >
          Kaizen is not configured on this deployment.
        </div>

        <div v-else class="grid flex-1 grid-cols-1 gap-6 overflow-auto p-6 lg:grid-cols-3">
          <!-- Verified combos -->
          <section class="lg:col-span-1">
            <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <UIcon name="i-lucide-badge-check" class="h-4 w-4 text-emerald-400" />
              Verified combos
              <span class="text-xs font-normal text-slate-500">({{ kaizen.verifiedCount }})</span>
            </h2>
            <p class="mb-3 text-[11px] text-slate-500">
              A prompt + agent + model combination that graded 5/5 with no recommendations five
              times in a row. These are no longer graded.
            </p>
            <ul class="space-y-2">
              <li
                v-for="c in kaizen.verified"
                :key="c.comboKey"
                class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5"
              >
                <div class="flex items-center gap-2">
                  <UIcon
                    :name="meta(c.agentKind).icon"
                    class="h-3.5 w-3.5 shrink-0"
                    :style="{ color: meta(c.agentKind).color }"
                  />
                  <span class="text-xs font-medium text-slate-200">{{
                    meta(c.agentKind).label
                  }}</span>
                  <UIcon
                    v-if="c.verified"
                    name="i-lucide-badge-check"
                    class="ml-auto h-3.5 w-3.5 text-emerald-400"
                  />
                  <span v-else class="ml-auto text-[11px] text-slate-500">
                    {{ c.consecutiveHighGrades }}/5
                  </span>
                </div>
                <div class="mt-1 truncate text-[11px] text-slate-500" :title="c.model">
                  {{ c.model }} · prompt v{{ c.promptVersion }}
                </div>
              </li>
              <li v-if="kaizen.verified.length === 0" class="text-xs text-slate-600">
                No combos yet.
              </li>
            </ul>
          </section>

          <!-- Grading history -->
          <section class="lg:col-span-2">
            <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <UIcon name="i-lucide-history" class="h-4 w-4 text-teal-400" />
              Grading history
            </h2>
            <div class="overflow-hidden rounded-lg border border-slate-800">
              <table class="w-full text-left text-xs">
                <thead class="bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th class="px-3 py-2 font-medium">When</th>
                    <th class="px-3 py-2 font-medium">Agent</th>
                    <th class="px-3 py-2 font-medium">Model</th>
                    <th class="px-3 py-2 font-medium">Grade</th>
                    <th class="px-3 py-2 font-medium">Recommendations</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/70">
                  <tr v-for="g in kaizen.history" :key="g.id" class="align-top">
                    <td class="whitespace-nowrap px-3 py-2 text-slate-500">
                      {{ when(g.createdAt) }}
                    </td>
                    <td class="px-3 py-2">
                      <span class="flex items-center gap-1.5">
                        <UIcon
                          :name="meta(g.agentKind).icon"
                          class="h-3.5 w-3.5"
                          :style="{ color: meta(g.agentKind).color }"
                        />
                        <span class="text-slate-200">{{ meta(g.agentKind).label }}</span>
                        <span class="text-slate-600">v{{ g.promptVersion }}</span>
                      </span>
                    </td>
                    <td class="max-w-[12rem] truncate px-3 py-2 text-slate-400" :title="g.model">
                      {{ g.model }}
                    </td>
                    <td class="whitespace-nowrap px-3 py-2 font-semibold" :class="gradeTone(g)">
                      {{ statusLabel(g) }}
                    </td>
                    <td class="px-3 py-2 text-slate-400">
                      <ul v-if="g.recommendations.length" class="list-disc space-y-0.5 pl-4">
                        <li v-for="(r, i) in g.recommendations" :key="i">{{ r }}</li>
                      </ul>
                      <span v-else-if="g.status === 'complete'" class="text-slate-600">—</span>
                      <span v-else-if="g.error" class="text-rose-400/80">{{ g.error }}</span>
                    </td>
                  </tr>
                  <tr v-if="kaizen.history.length === 0">
                    <td colspan="5" class="px-3 py-6 text-center text-slate-600">
                      No gradings yet.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kz-fade-enter-active,
.kz-fade-leave-active {
  transition: opacity 0.15s ease;
}
.kz-fade-enter-from,
.kz-fade-leave-to {
  opacity: 0;
}
</style>
