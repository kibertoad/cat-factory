import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  isLaneGroupKey,
  isLaneSortKey,
  type LaneGroupKey,
  type LaneSortKey,
} from '~/utils/laneSort'

/**
 * How this reader wants a frame's swimlanes ordered and grouped, plus whether the Done lane
 * is open.
 *
 * Per USER and per BROWSER, persisted like the interface tier and the agent tier. That is a
 * deliberate split from the Done lane's two CAPS, which are per-workspace settings: what the
 * board may show is a shared decision about a service's history, while the order a reader
 * scans it in is personal and changes several times an hour. Making the order shared would
 * mean one person's triage sweep re-arranging everyone else's board.
 *
 * `sortKey` defaults to `smart`, which is per-lane (see `SMART_ORDER_BY_LANE`) rather than one
 * global order — the actionable order genuinely differs by column. The explicit keys are an
 * OVERRIDE of that, which is why the control offering them is an advanced-tier affordance:
 * hiding it in basic mode leaves exactly the default it would have shown.
 */
export const useLaneViewStore = defineStore(
  'laneView',
  () => {
    // Stored raw and narrowed on read, the same split `uiMode` uses for `storedMode`. A setup
    // store can only persist what it returns, so these are reachable directly; the narrowing
    // below is what makes that safe rather than a trust assumption.
    const storedSortKey = ref<string>('smart')
    const storedGroupKey = ref<string>('none')
    /**
     * Collapsed by default. The lane's job is to prove finished work exists and give a route
     * to it, and a service with a long history would otherwise open as a wall of merged
     * cards nobody asked to read.
     */
    const doneLaneCollapsed = ref(true)

    const sortKey = computed<LaneSortKey>(() =>
      isLaneSortKey(storedSortKey.value) ? storedSortKey.value : 'smart',
    )
    const groupKey = computed<LaneGroupKey>(() =>
      isLaneGroupKey(storedGroupKey.value) ? storedGroupKey.value : 'none',
    )

    /**
     * Whether the reader has overridden the defaults. Drives `showOverrideField`, so a
     * preference set in advanced mode stays visible (and clearable) after a switch to basic
     * — the one case where hiding an override would conceal a setting the board is using.
     */
    const hasOverride = computed(() => sortKey.value !== 'smart' || groupKey.value !== 'none')

    function setSortKey(next: LaneSortKey) {
      storedSortKey.value = next
    }

    function setGroupKey(next: LaneGroupKey) {
      storedGroupKey.value = next
    }

    function reset() {
      storedSortKey.value = 'smart'
      storedGroupKey.value = 'none'
    }

    function toggleDoneLane() {
      doneLaneCollapsed.value = !doneLaneCollapsed.value
    }

    return {
      storedSortKey,
      storedGroupKey,
      doneLaneCollapsed,
      sortKey,
      groupKey,
      hasOverride,
      setSortKey,
      setGroupKey,
      reset,
      toggleDoneLane,
    }
  },
  { persist: { pick: ['storedSortKey', 'storedGroupKey', 'doneLaneCollapsed'] } },
)
