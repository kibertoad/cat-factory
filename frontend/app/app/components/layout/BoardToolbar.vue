<script setup lang="ts">
import { useBoardFlow } from '~/composables/useBoardFlow'
import NotificationsInbox from '~/components/layout/NotificationsInbox.vue'

const ui = useUiStore()
const board = useBoardStore()
const execution = useExecutionStore()
const workspace = useWorkspaceStore()
const workspaceSettings = useWorkspaceSettingsStore()
const services = useServicesStore()
const toast = useToast()
const { t, n } = useI18n()
const { fitView, zoomIn, zoomOut } = useBoardFlow()

async function mountService(serviceId: string, title: string) {
  try {
    await services.mount(serviceId)
    toast.add({
      title: t('board.toolbar.serviceAdded', { title }),
      icon: 'i-lucide-box',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('board.toolbar.serviceAddFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  }
}

// The org's services not yet on this board — mounting one adds its shared frame here.
const mountableItems = computed(() =>
  services.mountable.map((s) => {
    const title = board.getBlock(s.frameBlockId)?.title ?? s.frameBlockId
    return {
      label: title,
      icon: 'i-lucide-box',
      onSelect: () => {
        void mountService(s.id, title)
      },
    }
  }),
)

const zoomPct = computed(() => Math.round(ui.zoom * 100))
// Exhaustive (tier-2) map from level-of-detail → its label key, so adding an LOD
// without a label fails the typecheck rather than leaking a raw key.
const LOD_LABEL_KEYS = {
  far: 'board.toolbar.lod.far',
  mid: 'board.toolbar.lod.mid',
  close: 'board.toolbar.lod.close',
  steps: 'board.toolbar.lod.steps',
  subtasks: 'board.toolbar.lod.subtasks',
} as const
const lodLabel = computed(() => t(LOD_LABEL_KEYS[ui.lod]))

// Live spend indicator: shown once the workspace has an explicit budget configured
// (so the meter appears the moment a budget is set, at zero spend), or once any tokens
// have been metered this period (the built-in default budget still applies unconfigured).
const spend = computed(() => workspace.spend)
const budgetConfigured = computed(
  () =>
    workspaceSettings.settings.spendMonthlyLimit != null ||
    workspaceSettings.settings.spendCurrency != null,
)
const showSpend = computed(
  () => !!spend.value && (budgetConfigured.value || spend.value.costSpent > 0),
)
const spendLabel = computed(() => {
  const s = spend.value
  if (!s) return ''
  const fmt = (value: number) => {
    try {
      return n(value, { key: 'currency', currency: s.currency })
    } catch {
      return `${value.toFixed(2)} ${s.currency}`
    }
  }
  return `${fmt(s.costSpent)} / ${fmt(s.costLimit)}`
})
const spendColor = computed(() => (spend.value?.exceeded ? 'error' : 'neutral'))

const decisionItems = computed(() =>
  execution.openDecisions.map((d) => {
    const b = board.getBlock(d.blockId)
    return {
      label: b?.title ?? t('common.block'),
      description: d.decision.question,
      icon: 'i-lucide-circle-help',
      onSelect: () => ui.openDecision(d.instanceId, d.decision.id),
    }
  }),
)
</script>

<template>
  <div
    class="absolute left-1/2 top-3 z-20 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-slate-700 bg-slate-900/90 px-2 py-1.5 shadow-xl backdrop-blur"
  >
    <!-- zoom controls -->
    <UButton
      icon="i-lucide-zoom-out"
      color="neutral"
      variant="ghost"
      size="sm"
      data-testid="board-zoom-out"
      @click="zoomOut()"
    />
    <!-- The zoom %/LOD readout is the first thing to drop on narrow viewports. -->
    <div class="hidden w-20 text-center text-xs tabular-nums text-slate-300 sm:block">
      {{ zoomPct }}%
      <div class="text-[9px] uppercase tracking-wide text-slate-500">{{ lodLabel }}</div>
    </div>
    <UButton
      icon="i-lucide-zoom-in"
      color="neutral"
      variant="ghost"
      size="sm"
      data-testid="board-zoom-in"
      @click="zoomIn()"
    />
    <UButton
      icon="i-lucide-maximize"
      color="neutral"
      variant="ghost"
      size="sm"
      data-testid="board-fit-view"
      @click="fitView({ padding: 0.2 })"
    />

    <USeparator orientation="vertical" class="mx-1 h-6" />

    <!-- decisions queue -->
    <UDropdownMenu v-if="execution.pendingDecisionCount" :items="decisionItems">
      <UButton
        color="warning"
        variant="soft"
        size="sm"
        icon="i-lucide-circle-help"
        data-testid="decision-badge"
      >
        {{ execution.pendingDecisionCount
        }}<span class="hidden sm:inline"
          >&nbsp;{{ t('board.toolbar.decisionWord', execution.pendingDecisionCount) }}</span
        >
      </UButton>
    </UDropdownMenu>

    <!-- in-org sharing: add an existing org service to this board -->
    <UDropdownMenu v-if="mountableItems.length" :items="mountableItems">
      <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-plus-circle">
        <span class="hidden sm:inline">{{ t('board.toolbar.addService') }}</span>
      </UButton>
    </UDropdownMenu>

    <!-- human-actionable notifications (merge review, pipeline complete, CI failed) -->
    <NotificationsInbox />

    <!-- spend safeguard usage -->
    <UButton
      v-if="showSpend"
      :color="spendColor"
      variant="soft"
      size="sm"
      icon="i-lucide-wallet"
      :title="
        spend?.exceeded ? t('board.toolbar.spendLimitReached') : t('board.toolbar.spendTitle')
      "
    >
      <span class="hidden sm:inline">{{ spendLabel }}</span>
    </UButton>
  </div>
</template>
