<script setup lang="ts">
// The single rendering path for an agent kind's icon (+ optional label) anywhere a
// pipeline or run lists its steps. Resolves display metadata through
// `agentKindMeta`, which is total over every kind — palette archetypes, custom
// agents and the engine's system kinds (ci / merger / blueprints / conflicts) — so
// a saved pipeline that contains a system kind can never blow up the renderer.
import { computed } from 'vue'
import { agentKindMeta } from '~/utils/catalog'

const props = withDefaults(
  defineProps<{ kind: string; showLabel?: boolean; iconClass?: string }>(),
  { showLabel: false, iconClass: 'h-4 w-4' },
)

const meta = computed(() => agentKindMeta(props.kind))
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <UIcon
      :name="meta.icon"
      :class="iconClass"
      class="shrink-0"
      :style="{ color: meta.color }"
      :title="meta.label"
    />
    <span v-if="showLabel" class="text-xs text-slate-100">{{ meta.label }}</span>
  </span>
</template>
