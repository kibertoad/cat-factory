<script setup lang="ts">
import LaneTask from './LaneTask.vue'
import { MODULE_META, taskTypeMeta } from '~/utils/catalog'
import type { LaneGroup, LaneGroupKey } from '~/utils/laneSort'
import { LANE_REASON_LABEL_KEYS, type LaneReason } from '~/utils/swimlanes'

/**
 * One labelled run of cards inside a lane.
 *
 * The WRAPPER carries `data-drop-zone`, not the header, so dropping anywhere in a module's group
 * — on its title or on a card already in it — means "into that module". With the zone on the
 * header alone, a drop onto one of the group's own cards would fall through to the lane's frame
 * zone and reparent the card OUT of the module it was dropped into, which is the opposite of
 * what the gesture said.
 *
 * That drop target is also why module grouping matters beyond presentation: module sub-frames no
 * longer render as boxes, so this is the board's drag route into a module. The inspector's module
 * picker is the route that does not depend on the current grouping.
 */
const props = defineProps<{
  group: LaneGroup
  groupKey: LaneGroupKey
  /** The enclosing service frame, so the catch-all group can be the way back OUT of a module. */
  frameId: string
}>()

const { t } = useI18n()

/**
 * Which block a drop onto this group reparents into.
 *
 * Only meaningful while grouping BY MODULE: a named group targets its module block, and the
 * catch-all ("no module") targets the frame, which is what makes dragging a card out of a module
 * possible. Under any other grouping the group is not a container at all, so it declares no zone
 * and drops fall through to the lane's own frame zone.
 */
const dropZone = computed(() => {
  if (props.groupKey !== 'module') return null
  return props.group.label == null ? props.frameId : props.group.id
})

/** Group labels are DATA (a module name, a type, a reason), so each kind is rendered as itself. */
const label = computed(() => {
  const raw = props.group.label
  // `none` grouping renders no header at all, so it has no catch-all label to name.
  if (props.groupKey === 'none') return ''
  if (raw == null) return t(`board.lanes.group.catchAll.${props.groupKey}`)
  if (props.groupKey === 'task_type') return taskTypeMeta(raw).label
  if (props.groupKey === 'blocking_reason') {
    return t(LANE_REASON_LABEL_KEYS[raw as LaneReason] ?? 'board.lanes.reason.unclassified')
  }
  return raw
})

const icon = computed(() => {
  if (props.groupKey === 'module') return MODULE_META.icon
  if (props.groupKey === 'initiative') return 'i-lucide-flag'
  if (props.groupKey === 'epic') return 'i-lucide-layers'
  return null
})
</script>

<template>
  <div :data-drop-zone="dropZone ?? undefined" class="space-y-1.5">
    <!-- `none` grouping renders no header: one unlabelled group IS the flat lane, and a header
         saying "all of them" would be a row of chrome carrying no information. -->
    <div
      v-if="groupKey !== 'none'"
      class="flex items-center gap-1 px-0.5 text-[10px] uppercase tracking-wide text-slate-500"
    >
      <UIcon v-if="icon" :name="icon" class="h-3 w-3 shrink-0" />
      <span class="truncate" :title="label">{{ label }}</span>
      <span class="ms-auto shrink-0 tabular-nums">{{ group.entries.length }}</span>
    </div>
    <LaneTask v-for="entry in group.entries" :key="entry.task.id" :task-id="entry.task.id" />
  </div>
</template>
