<script setup lang="ts">
// Startup advisory for unhealthy pipelines. Opened once per session from the board page when
// `usePipelineHealth` reports any issue. Lists:
//   • invalid pipelines (unknown agent kind / bad shape) — DELETE a custom one, RESEED a built-in;
//   • outdated built-ins (a newer catalog definition is available) — RESEED to adopt it.
// Detection is client-side (see usePipelineHealth); the actions hit the pipelines store.
const { t } = useI18n()
const ui = useUiStore()
const pipelines = usePipelinesStore()
const { invalid, outdated, hasIssues } = usePipelineHealth()
const toast = useToast()

const open = computed({
  get: () => ui.pipelineHealthOpen,
  set: (v: boolean) => {
    if (!v) ui.closePipelineHealth()
  },
})

// Per-pipeline in-flight ids, so each row's button shows its own spinner.
const busy = ref<Set<string>>(new Set())
const isBusy = (id: string) => busy.value.has(id)
const anyBusy = computed(() => busy.value.size > 0)

async function run(id: string, action: () => Promise<unknown>, failTitle: string) {
  busy.value = new Set(busy.value).add(id)
  try {
    await action()
  } catch (e) {
    toast.add({
      title: failTitle,
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    const next = new Set(busy.value)
    next.delete(id)
    busy.value = next
  }
}

const reseed = (id: string) =>
  run(id, () => pipelines.reseed(id), t('pipeline.health.toast.reseedFailed'))
const remove = (id: string) =>
  run(id, () => pipelines.removePipeline(id), t('pipeline.health.toast.deleteFailed'))

/** Reseed every reseedable pipeline (outdated built-ins + invalid built-ins) in one go. */
async function reseedAll() {
  const ids = [...invalid.value.filter((h) => h.pipeline.builtin), ...outdated.value].map(
    (h) => h.pipeline.id,
  )
  for (const id of new Set(ids)) await reseed(id)
}

const reseedableCount = computed(
  () =>
    new Set([
      ...invalid.value.filter((h) => h.pipeline.builtin).map((h) => h.pipeline.id),
      ...outdated.value.map((h) => h.pipeline.id),
    ]).size,
)
</script>

<template>
  <UModal v-model:open="open" :title="t('pipeline.health.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="!hasIssues" class="py-6 text-center text-sm text-slate-400">
        <UIcon name="i-lucide-check-circle-2" class="mx-auto mb-2 h-8 w-8 text-emerald-400" />
        {{ t('pipeline.health.allValid') }}
      </div>

      <div v-else class="space-y-5">
        <!-- Invalid: unknown agent kinds or a broken shape. -->
        <section v-if="invalid.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-triangle-alert" class="h-4 w-4 text-rose-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.invalidHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">
            {{ t('pipeline.health.invalidDescription') }}
          </p>
          <ul class="space-y-2">
            <li
              v-for="h in invalid"
              :key="h.pipeline.id"
              class="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium text-slate-100">
                      {{ h.pipeline.name }}
                    </span>
                    <UBadge v-if="h.pipeline.builtin" color="neutral" variant="subtle" size="xs">
                      {{ t('pipeline.health.builtinBadge') }}
                    </UBadge>
                  </div>
                  <ul class="mt-1 space-y-0.5">
                    <li
                      v-for="(p, i) in h.problems"
                      :key="i"
                      class="text-[11px]"
                      :class="p.type === 'outdated' ? 'text-amber-400/80' : 'text-rose-400/90'"
                    >
                      {{ p.message }}
                    </li>
                  </ul>
                </div>
                <UButton
                  v-if="h.pipeline.builtin"
                  size="xs"
                  color="primary"
                  variant="subtle"
                  icon="i-lucide-rotate-ccw"
                  :loading="isBusy(h.pipeline.id)"
                  :disabled="anyBusy"
                  @click="reseed(h.pipeline.id)"
                >
                  {{ t('pipeline.health.reseed') }}
                </UButton>
                <UButton
                  v-else
                  size="xs"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-trash-2"
                  :loading="isBusy(h.pipeline.id)"
                  :disabled="anyBusy"
                  @click="remove(h.pipeline.id)"
                >
                  {{ t('pipeline.health.delete') }}
                </UButton>
              </div>
            </li>
          </ul>
        </section>

        <!-- Outdated built-ins: a newer catalog version is available. -->
        <section v-if="outdated.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-arrow-up-circle" class="h-4 w-4 text-amber-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.updatesHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">
            {{ t('pipeline.health.updatesDescription') }}
          </p>
          <ul class="space-y-2">
            <li
              v-for="h in outdated"
              :key="h.pipeline.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100">{{
                  h.pipeline.name
                }}</span>
                <p class="text-[11px] text-amber-400/80">{{ h.problems[0]?.message }}</p>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="subtle"
                icon="i-lucide-rotate-ccw"
                :loading="isBusy(h.pipeline.id)"
                :disabled="anyBusy"
                @click="reseed(h.pipeline.id)"
              >
                {{ t('pipeline.health.reseed') }}
              </UButton>
            </li>
          </ul>
        </section>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="reseedableCount > 1"
          color="primary"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :loading="anyBusy"
          @click="reseedAll"
        >
          {{ t('pipeline.health.reseedAll', { count: reseedableCount }) }}
        </UButton>
        <span v-else />
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="anyBusy"
          @click="ui.closePipelineHealth()"
        >
          {{ hasIssues ? t('pipeline.health.dismiss') : t('pipeline.health.done') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
