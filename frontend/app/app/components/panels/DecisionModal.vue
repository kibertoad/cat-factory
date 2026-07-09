<script setup lang="ts">
import { agentKindMeta } from '~/utils/catalog'

const execution = useExecutionStore()
const board = useBoardStore()
const ui = useUiStore()
const toast = useToast()
const { t } = useI18n()

const ctx = computed(() => ui.decisionContext)

const instance = computed(() => execution.getInstance(ctx.value?.instanceId))
const step = computed(() =>
  instance.value?.steps.find((s) => s.decision?.id === ctx.value?.decisionId),
)
const decision = computed(() => step.value?.decision ?? null)
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))
const agent = computed(() => (step.value ? agentKindMeta(step.value.agentKind) : null))

const open = computed({
  get: () => !!ctx.value && !!decision.value,
  set: (v: boolean) => {
    if (!v) ui.closeDecision()
  },
})

// UX-25: which option is being resolved (null = idle). Guards against a fire-and-forget
// double-submit — the resolve is awaited, all options disable while it runs, and a failed
// resolve keeps the modal open with an error toast instead of closing silently.
const resolvingOption = ref<string | null>(null)

async function choose(option: string) {
  if (!ctx.value || resolvingOption.value) return
  resolvingOption.value = option
  try {
    // `resolveDecision` returns false when a required-credential prompt is cancelled — keep
    // the modal open in that case so the choice isn't silently dropped.
    const resolved = await execution.resolveDecision(
      ctx.value.instanceId,
      ctx.value.decisionId,
      option,
    )
    if (resolved) ui.closeDecision()
  } catch (e) {
    toast.add({
      title: t('panels.decision.resolveFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    resolvingOption.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('panels.decision.title')">
    <template #body>
      <div v-if="decision && agent" class="space-y-4" data-testid="decision-modal">
        <div class="flex items-center gap-2 text-sm text-slate-400">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-lg"
            :style="{ backgroundColor: agent.color + '22' }"
          >
            <UIcon :name="agent.icon" class="h-4 w-4" :style="{ color: agent.color }" />
          </div>
          <div>
            <i18n-t v-if="block" keypath="panels.decision.agentOnBlock" tag="span" scope="global">
              <template #agent>
                <span class="font-medium text-slate-200">{{ agent.label }}</span>
              </template>
              <template #block>
                <span class="font-medium text-slate-200">{{ block.title }}</span>
              </template>
            </i18n-t>
            <span v-else class="font-medium text-slate-200">{{ agent.label }}</span>
          </div>
        </div>

        <p class="text-base font-medium text-white">{{ decision.question }}</p>

        <div class="grid gap-2">
          <UButton
            v-for="opt in decision.options"
            :key="opt"
            color="primary"
            variant="soft"
            block
            data-testid="decision-option"
            class="justify-start"
            :loading="resolvingOption === opt"
            :disabled="resolvingOption !== null && resolvingOption !== opt"
            @click="choose(opt)"
          >
            {{ opt }}
          </UButton>
        </div>
        <p class="text-[11px] text-slate-500">
          {{ t('panels.decision.visualizationHint') }}
        </p>
      </div>
    </template>
  </UModal>
</template>
