<script setup lang="ts">
import { computed, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { TableColumn } from '@nuxt/ui'
import type { KaizenGrading } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'

// The Kaizen screen: a full-panel overlay listing the workspace's grading history and
// its verified-combo library. Opened via `ui.openKaizen()` from the sidebar. Read-only —
// grading is scheduled by the engine and run by the background sweep, never from here.
const ui = useUiStore()
const kaizen = useKaizenStore()
const { t, d } = useI18n()

const open = computed(() => ui.kaizenScreenOpen)

watch(
  open,
  (isOpen) => {
    if (isOpen) void kaizen.loadOverview()
  },
  { immediate: true },
)

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
  return d(new Date(ms), 'long')
}
function gradeTone(g: KaizenGrading): string {
  if (g.status === 'failed') return 'text-dimmed'
  if (g.grade == null) return 'text-muted'
  if (g.grade >= 5) return 'text-app-success-400'
  if (g.grade >= 4) return 'text-app-hue-lime'
  if (g.grade === 3) return 'text-app-warning-400'
  return 'text-app-error-400'
}
function statusLabel(g: KaizenGrading): string {
  if (g.status === 'scheduled') return t('kaizen.status.scheduled')
  if (g.status === 'running') return t('kaizen.status.grading')
  if (g.status === 'failed') return t('kaizen.status.failed')
  return g.grade != null ? t('kaizen.gradeValue', { grade: g.grade }) : t('kaizen.status.graded')
}

// Column definitions rather than hand-written `<th>`s, so the header typography comes from the
// table theme and is the same one every other table in the SPA renders.
const historyColumns = computed<TableColumn<KaizenGrading>[]>(() => [
  { id: 'when', header: t('kaizen.history.col.when') },
  { id: 'agent', header: t('kaizen.history.col.agent') },
  { id: 'model', header: t('kaizen.history.col.model') },
  { id: 'grade', header: t('kaizen.history.col.grade') },
  { id: 'recommendations', header: t('kaizen.history.col.recommendations') },
])
</script>

<template>
  <Teleport to="body">
    <Transition name="kz-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex flex-col bg-app-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-default px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-hue-teal/15"
          >
            <UIcon name="i-lucide-sparkles" class="h-5 w-5 text-app-hue-teal" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-highlighted">
              {{ t('kaizen.title') }}
            </h1>
            <p class="truncate text-xs text-dimmed">
              {{ t('kaizen.subtitle') }}
            </p>
          </div>
          <div class="ms-auto flex items-center gap-2">
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="kaizen.loadingOverview"
              @click="kaizen.loadOverview()"
            >
              {{ t('kaizen.refresh') }}
            </UButton>
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="close">
              {{ t('common.close') }}
            </UButton>
          </div>
        </header>

        <div
          v-if="kaizen.available === false"
          class="flex flex-1 items-center justify-center text-sm text-dimmed"
        >
          {{ t('kaizen.notConfigured') }}
        </div>

        <div v-else class="grid flex-1 grid-cols-1 gap-6 overflow-auto p-6 lg:grid-cols-3">
          <!-- Verified combos -->
          <section class="lg:col-span-1">
            <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold text-default">
              <UIcon name="i-lucide-badge-check" class="h-4 w-4 text-app-success-400" />
              {{ t('kaizen.verifiedCombos.title') }}
              <span class="text-xs font-normal text-dimmed">{{
                t('kaizen.verifiedCombos.count', { count: kaizen.verifiedCount })
              }}</span>
            </h2>
            <p class="mb-3 text-2xs text-dimmed">
              {{ t('kaizen.verifiedCombos.hint') }}
            </p>
            <ul class="space-y-2">
              <li
                v-for="c in kaizen.verified"
                :key="c.comboKey"
                class="rounded-lg border border-default bg-default/40 p-2.5"
              >
                <div class="flex items-center gap-2">
                  <UIcon
                    :name="meta(c.agentKind).icon"
                    class="h-3.5 w-3.5 shrink-0"
                    :style="{ color: meta(c.agentKind).color }"
                  />
                  <span class="text-xs font-medium text-default">{{
                    meta(c.agentKind).label
                  }}</span>
                  <UIcon
                    v-if="c.verified"
                    name="i-lucide-badge-check"
                    class="ms-auto h-3.5 w-3.5 text-app-success-400"
                  />
                  <span v-else class="ms-auto text-2xs text-dimmed">
                    {{ t('kaizen.verifiedCombos.progress', { count: c.consecutiveHighGrades }) }}
                  </span>
                </div>
                <div class="mt-1 truncate text-2xs text-dimmed" :title="c.model">
                  {{
                    t('kaizen.verifiedCombos.modelPrompt', {
                      model: c.model,
                      version: c.promptVersion,
                    })
                  }}
                </div>
              </li>
              <li v-if="kaizen.verified.length === 0" class="text-xs text-app-600">
                {{ t('kaizen.verifiedCombos.empty') }}
              </li>
            </ul>
          </section>

          <!-- Grading history -->
          <section class="lg:col-span-2">
            <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold text-default">
              <UIcon name="i-lucide-history" class="h-4 w-4 text-app-hue-teal" />
              {{ t('kaizen.history.title') }}
            </h2>
            <UTable
              :data="kaizen.history"
              :columns="historyColumns"
              :ui="{
                root: 'overflow-hidden rounded-lg border border-default',
                base: 'text-xs',
                tr: 'align-top',
              }"
            >
              <template #when-cell="{ row }">
                <span class="whitespace-nowrap text-dimmed">{{
                  when(row.original.createdAt)
                }}</span>
              </template>
              <template #agent-cell="{ row }">
                <span class="flex items-center gap-1.5">
                  <UIcon
                    :name="meta(row.original.agentKind).icon"
                    class="h-3.5 w-3.5"
                    :style="{ color: meta(row.original.agentKind).color }"
                  />
                  <span class="text-default">{{ meta(row.original.agentKind).label }}</span>
                  <span class="text-app-600">{{
                    t('kaizen.promptVersion', { version: row.original.promptVersion })
                  }}</span>
                </span>
              </template>
              <template #model-cell="{ row }">
                <span class="block max-w-[12rem] truncate text-muted" :title="row.original.model">
                  {{ row.original.model }}
                </span>
              </template>
              <template #grade-cell="{ row }">
                <span class="whitespace-nowrap font-semibold" :class="gradeTone(row.original)">
                  {{ statusLabel(row.original) }}
                </span>
              </template>
              <template #recommendations-cell="{ row }">
                <div class="text-muted">
                  <ul v-if="row.original.recommendations.length" class="list-disc space-y-0.5 ps-4">
                    <li v-for="(r, i) in row.original.recommendations" :key="i">{{ r }}</li>
                  </ul>
                  <span v-else-if="row.original.status === 'complete'" class="text-app-600">
                    &mdash;
                  </span>
                  <span v-else-if="row.original.error" class="text-app-error-400/80">
                    {{ row.original.error }}
                  </span>
                </div>
              </template>
              <template #empty>
                <span class="text-app-600">{{ t('kaizen.history.empty') }}</span>
              </template>
            </UTable>
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
