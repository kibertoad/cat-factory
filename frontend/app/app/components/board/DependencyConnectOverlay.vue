<script setup lang="ts">
import { useDependencyConnect } from '~/composables/useDependencyConnect'

// Draws the live preview line while a dependency drag-to-connect is in progress. Mounted
// once on the board; reads the shared connect state. Fixed, full-viewport, click-through.
const { connecting } = useDependencyConnect()
</script>

<template>
  <svg
    v-if="connecting"
    class="pointer-events-none fixed inset-0 z-50 h-full w-full overflow-visible"
  >
    <line
      :x1="connecting.x1"
      :y1="connecting.y1"
      :x2="connecting.x2"
      :y2="connecting.y2"
      stroke="#f59e0b"
      :stroke-width="2"
      stroke-dasharray="5 4"
      stroke-opacity="0.9"
    />
  </svg>
</template>
