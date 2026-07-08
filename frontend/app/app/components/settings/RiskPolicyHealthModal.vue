<script setup lang="ts">
// Startup advisory for built-in merge presets that drifted from the catalog. Opened once per
// session from the board page when `useRiskPolicyHealth` reports any issue. Lists:
//   • new built-in presets the workspace doesn't have yet (ADD them);
//   • built-ins with a newer catalog version available (RESEED to adopt it).
// Both fixes are the same reseed call (it creates or updates by catalog id). Detection is
// client-side (see useRiskPolicyHealth); the actions hit the riskPolicies store.
const { t } = useI18n()
const ui = useUiStore()
const presets = useRiskPoliciesStore()
const { newPresets, outdated, hasIssues } = useRiskPolicyHealth()
const toast = useToast()

const open = computed({
  get: () => ui.riskPolicyHealthOpen,
  set: (v: boolean) => {
    if (!v) ui.closeRiskPolicyHealth()
  },
})

// Per-preset in-flight ids, so each row's button shows its own spinner.
const busy = ref<Set<string>>(new Set())
const isBusy = (id: string) => busy.value.has(id)
const anyBusy = computed(() => busy.value.size > 0)

async function reseed(id: string) {
  busy.value = new Set(busy.value).add(id)
  try {
    await presets.reseed(id)
  } catch (e) {
    toast.add({
      title: t('riskPolicy.health.toast.reseedFailed'),
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

/** Reseed every advised preset (new + outdated built-ins) in one go. */
async function reseedAll() {
  const ids = [...newPresets.value, ...outdated.value].map((i) => i.id)
  for (const id of new Set(ids)) await reseed(id)
}

const reseedableCount = computed(
  () => new Set([...newPresets.value, ...outdated.value].map((i) => i.id)).size,
)
</script>

<template>
  <UModal v-model:open="open" :title="t('riskPolicy.health.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="!hasIssues" class="py-6 text-center text-sm text-slate-400">
        <UIcon name="i-lucide-check-circle-2" class="mx-auto mb-2 h-8 w-8 text-emerald-400" />
        {{ t('riskPolicy.health.allValid') }}
      </div>

      <div v-else class="space-y-5">
        <!-- New built-in presets the workspace can add. -->
        <section v-if="newPresets.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-sparkles" class="h-4 w-4 text-emerald-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('riskPolicy.health.newHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('riskPolicy.health.newDescription') }}</p>
          <ul class="space-y-2">
            <li
              v-for="i in newPresets"
              :key="i.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100 capitalize">{{
                  i.name
                }}</span>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="subtle"
                icon="i-lucide-plus"
                :loading="isBusy(i.id)"
                :disabled="anyBusy"
                @click="reseed(i.id)"
              >
                {{ t('riskPolicy.health.add') }}
              </UButton>
            </li>
          </ul>
        </section>

        <!-- Outdated built-ins: a newer catalog version is available. -->
        <section v-if="outdated.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-arrow-up-circle" class="h-4 w-4 text-amber-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('riskPolicy.health.updatesHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('riskPolicy.health.updatesDescription') }}</p>
          <ul class="space-y-2">
            <li
              v-for="i in outdated"
              :key="i.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100">{{ i.name }}</span>
                <p class="text-[11px] text-amber-400/80">
                  {{
                    t('riskPolicy.health.versionAvailable', {
                      from: i.fromVersion ?? 0,
                      to: i.toVersion ?? 0,
                    })
                  }}
                </p>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="subtle"
                icon="i-lucide-rotate-ccw"
                :loading="isBusy(i.id)"
                :disabled="anyBusy"
                @click="reseed(i.id)"
              >
                {{ t('riskPolicy.health.reseed') }}
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
          {{ t('riskPolicy.health.reseedAll', { count: reseedableCount }) }}
        </UButton>
        <span v-else />
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="anyBusy"
          @click="ui.closeRiskPolicyHealth()"
        >
          {{ hasIssues ? t('riskPolicy.health.dismiss') : t('riskPolicy.health.done') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
