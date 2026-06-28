<script setup lang="ts">
import { computed } from 'vue'

const { t, n } = useI18n()
const workspace = useWorkspaceStore()

const spend = computed(() => workspace.spend)
/** Show the large warning only once the budget has been reached. */
const exceeded = computed(() => spend.value?.exceeded ?? false)

function money(amount: number, currency: string) {
  return n(amount, { key: 'currency', currency })
}

const tokens = computed(() => {
  const s = spend.value
  if (!s) return ''
  return n(s.inputTokens + s.outputTokens, 'decimal')
})

const resuming = ref(false)
async function resume() {
  resuming.value = true
  try {
    await workspace.resumeSpend()
  } finally {
    resuming.value = false
  }
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="exceeded && spend"
      class="absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      <div
        class="w-full max-w-3xl rounded-2xl border-2 border-red-500/70 bg-red-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-octagon-alert" class="mt-0.5 h-10 w-10 shrink-0 text-red-400" />
          <div class="min-w-0 flex-1">
            <h2 class="text-lg font-semibold text-red-100">
              {{ t('layout.spendWarningBanner.title') }}
            </h2>
            <p class="mt-1 text-sm text-red-200/90">
              {{ t('layout.spendWarningBanner.body') }}
            </p>

            <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div class="rounded-lg bg-red-900/50 px-3 py-2">
                <dt class="text-[11px] uppercase tracking-wide text-red-300/80">
                  {{ t('layout.spendWarningBanner.spent') }}
                </dt>
                <dd class="text-base font-semibold tabular-nums text-red-50">
                  {{ money(spend.costSpent, spend.currency) }}
                </dd>
              </div>
              <div class="rounded-lg bg-red-900/50 px-3 py-2">
                <dt class="text-[11px] uppercase tracking-wide text-red-300/80">
                  {{ t('layout.spendWarningBanner.budget') }}
                </dt>
                <dd class="text-base font-semibold tabular-nums text-red-50">
                  {{ money(spend.costLimit, spend.currency) }}
                </dd>
              </div>
              <div class="rounded-lg bg-red-900/50 px-3 py-2">
                <dt class="text-[11px] uppercase tracking-wide text-red-300/80">
                  {{ t('layout.spendWarningBanner.tokens') }}
                </dt>
                <dd class="text-base font-semibold tabular-nums text-red-50">{{ tokens }}</dd>
              </div>
            </dl>

            <div class="mt-4 flex items-center gap-3">
              <UButton
                color="error"
                variant="solid"
                icon="i-lucide-play"
                :loading="resuming"
                @click="resume"
              >
                {{ t('layout.spendWarningBanner.resume') }}
              </UButton>
              <span class="text-xs text-red-300/70">
                {{ t('layout.spendWarningBanner.resumeHint') }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
