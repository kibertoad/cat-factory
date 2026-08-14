<script setup lang="ts">
import {
  LANE_GROUP_KEYS,
  LANE_SORT_KEYS,
  type LaneGroupKey,
  type LaneSortKey,
} from '~/utils/laneSort'
import { showOverrideField } from '~/utils/uiMode'

/**
 * The board-level override for how every frame's swimlanes are ordered and grouped.
 *
 * It is an OVERRIDE, which is what makes it an advanced-tier affordance: hidden, what remains is
 * exactly the `smart` per-lane order and no grouping — the default it would otherwise have shown.
 * The gate is `showOverrideField` rather than `isAdvanced` alone, because the preference persists
 * per browser: someone who picks "by severity" in advanced mode and then switches to basic must
 * still be able to see and clear it, or the board would be ordered by a rule they cannot find.
 */
const { t } = useI18n()
const uiMode = useUiModeStore()
const laneView = useLaneViewStore()

// The DEFAULT values are passed as `undefined` rather than as themselves: `showOverrideField`
// reveals the control as soon as any value it edits is set, and `smart`/`none` being set is
// exactly the state where there is nothing to reveal.
const visible = computed(() =>
  showOverrideField(
    uiMode.isAdvanced,
    laneView.sortKey === 'smart' ? undefined : laneView.sortKey,
    laneView.groupKey === 'none' ? undefined : laneView.groupKey,
  ),
)

const sortItems = computed(() =>
  LANE_SORT_KEYS.map((key) => ({
    label: t(`board.lanes.sort.${key}`),
    icon: laneView.sortKey === key ? 'i-lucide-check' : undefined,
    onSelect: () => laneView.setSortKey(key as LaneSortKey),
  })),
)

const groupItems = computed(() =>
  LANE_GROUP_KEYS.map((key) => ({
    label: t(`board.lanes.group.${key}`),
    icon: laneView.groupKey === key ? 'i-lucide-check' : undefined,
    onSelect: () => laneView.setGroupKey(key as LaneGroupKey),
  })),
)

/**
 * One menu, two labelled sections, plus a reset. Grouped rather than two adjacent buttons because
 * the two choices are read together — "the newest bugs, by module" is one intent — and because the
 * toolbar has no room for two more controls at small widths.
 */
const items = computed(() => [
  [{ label: t('board.lanes.sort.heading'), type: 'label' as const }],
  sortItems.value,
  [{ label: t('board.lanes.group.heading'), type: 'label' as const }],
  groupItems.value,
  ...(laneView.hasOverride
    ? [
        [
          {
            label: t('board.lanes.resetView'),
            icon: 'i-lucide-rotate-ccw',
            onSelect: () => laneView.reset(),
          },
        ],
      ]
    : []),
])
</script>

<template>
  <UDropdownMenu v-if="visible" :items="items">
    <UButton
      color="neutral"
      :variant="laneView.hasOverride ? 'soft' : 'ghost'"
      size="sm"
      icon="i-lucide-arrow-down-up"
      :title="t('board.lanes.viewTitle')"
      data-testid="lane-view-control"
    >
      <span class="hidden sm:inline">{{ t('board.lanes.viewTitle') }}</span>
    </UButton>
  </UDropdownMenu>
</template>
