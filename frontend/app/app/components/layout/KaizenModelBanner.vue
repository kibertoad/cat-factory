<script setup lang="ts">
// Advisory banner shown when the Kaizen agent is enabled but its resolved model can't drive
// the inline grader (a subscription-only model with no inline harness, or nothing configured),
// so the backend skips grading those runs. Steers the user to point Kaizen at a compatible
// model in Model Configuration. Dismissible per session, mirroring AiProvidersBanner; its
// positioning/stacking is owned by the shared banner column in `pages/index.vue`.
import { computed } from 'vue'

const { t } = useI18n()
const ui = useUiStore()
const { modelUnfit } = useKaizenReadiness()

const show = computed(() => modelUnfit.value && !ui.kaizenModelDismissed)
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="pointer-events-auto w-full max-w-3xl">
      <div
        class="w-full max-w-3xl rounded-2xl border border-amber-500/50 bg-amber-950/90 p-4 shadow-xl backdrop-blur"
        role="alert"
      >
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-sparkles" class="mt-0.5 h-7 w-7 shrink-0 text-amber-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-sm font-semibold text-amber-100">
                {{ t('layout.kaizenModelBanner.title') }}
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                @click="ui.dismissKaizenModel()"
              />
            </div>
            <p class="mt-1 text-[13px] text-amber-200/90">
              {{ t('layout.kaizenModelBanner.body') }}
            </p>
            <div class="mt-3">
              <UButton
                size="sm"
                color="warning"
                variant="solid"
                icon="i-lucide-cpu"
                @click="ui.openModelConfig()"
              >
                {{ t('layout.kaizenModelBanner.action') }}
              </UButton>
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
