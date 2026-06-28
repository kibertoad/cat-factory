<script setup lang="ts">
// Full-screen artifact viewer — a reusable zoom/pan lightbox for a SET of stored images
// (screenshots / reference designs), shared by the visual-confirmation gate and the test
// report window. It reuses the owner's `useArtifactBlobs` cache (passed in as `blobs`) so
// opening the lightbox never re-fetches a blob the gallery already resolved.
//
// Zoom is pure CSS `transform` (GPU, no canvas), so even large PNGs stay smooth. Keyboard:
// Esc close · ←/→ prev/next · +/- zoom · 0 reset · double-click toggle fit↔2×.
import { computed, ref, watch } from 'vue'
import type { ArtifactBlobs } from '~/composables/useArtifactBlobs'

interface LightboxItem {
  artifactId: string
  label: string
  alt: string
}

const props = defineProps<{
  open: boolean
  index: number
  items: LightboxItem[]
  blobs: ArtifactBlobs
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'update:index', value: number): void
}>()

const MIN_SCALE = 1
const MAX_SCALE = 8
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

const current = computed(() => props.items[props.index] ?? null)
const total = computed(() => props.items.length)
const url = computed(() =>
  current.value ? props.blobs.urlFor(current.value.artifactId) : undefined,
)
const state = computed(() =>
  current.value ? props.blobs.statusFor(current.value.artifactId) : 'idle',
)

function resetView() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

// Resolve the active item (plus its immediate neighbours, so ←/→ is instant) whenever the
// lightbox is open or the index moves. Reset the zoom/pan on every navigation.
watch(
  () => [props.open, props.index, props.items.length] as const,
  () => {
    if (!props.open) return
    resetView()
    const ids = [props.index - 1, props.index, props.index + 1]
      .map((i) => props.items[i]?.artifactId)
      .filter((v): v is string => !!v)
    for (const id of ids) void props.blobs.resolve(id)
  },
  { immediate: true },
)

function close() {
  emit('update:open', false)
}
function go(delta: number) {
  if (!total.value) return
  const next = (props.index + delta + total.value) % total.value
  emit('update:index', next)
}
function zoomBy(factor: number) {
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor))
  if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)
}
function toggleZoom() {
  if (scale.value > 1) resetView()
  else scale.value = 2
}

// Pointer drag to pan (only meaningful when zoomed in).
const dragging = ref(false)
let startX = 0
let startY = 0
let baseX = 0
let baseY = 0
function onPointerDown(e: PointerEvent) {
  if (scale.value <= 1) return
  dragging.value = true
  startX = e.clientX
  startY = e.clientY
  baseX = tx.value
  baseY = ty.value
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  tx.value = baseX + (e.clientX - startX)
  ty.value = baseY + (e.clientY - startY)
}
function onPointerUp() {
  dragging.value = false
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return
  switch (e.key) {
    case 'Escape':
      e.stopPropagation()
      close()
      break
    case 'ArrowLeft':
      go(-1)
      break
    case 'ArrowRight':
      go(1)
      break
    case '+':
    case '=':
      zoomBy(1.25)
      break
    case '-':
    case '_':
      zoomBy(1 / 1.25)
      break
    case '0':
      resetView()
      break
  }
}
// Capture-phase so Esc closes the lightbox BEFORE the underlying window's own Esc handler
// (both use window keydown; the lightbox is the topmost surface so it wins).
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60] flex flex-col bg-slate-950/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      :aria-label="current ? `Screenshot: ${current.label}` : 'Screenshot viewer'"
      @click.self="close"
    >
      <!-- Toolbar -->
      <div class="flex items-center gap-3 border-b border-slate-800/60 px-4 py-2.5">
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-200">
          {{ current?.label ?? 'Screenshot' }}
        </span>
        <span v-if="total > 1" class="shrink-0 text-[12px] tabular-nums text-slate-400">
          {{ index + 1 }} / {{ total }}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
            title="Zoom out (-)"
            :disabled="scale <= MIN_SCALE"
            @click="zoomBy(1 / 1.25)"
          >
            <UIcon name="i-lucide-zoom-out" class="h-4 w-4" />
          </button>
          <span class="w-10 text-center text-[11px] tabular-nums text-slate-500"
            >{{ Math.round(scale * 100) }}%</span
          >
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
            title="Zoom in (+)"
            :disabled="scale >= MAX_SCALE"
            @click="zoomBy(1.25)"
          >
            <UIcon name="i-lucide-zoom-in" class="h-4 w-4" />
          </button>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="Reset (0)"
            @click="resetView"
          >
            <UIcon name="i-lucide-maximize" class="h-4 w-4" />
          </button>
          <button
            class="ml-1 rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="Close (Esc)"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Stage -->
      <div
        class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        @wheel="onWheel"
        @click.self="close"
      >
        <button
          v-if="total > 1"
          class="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-slate-900/80 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
          title="Previous (←)"
          @click="go(-1)"
        >
          <UIcon name="i-lucide-chevron-left" class="h-5 w-5" />
        </button>

        <img
          v-if="url"
          :src="url"
          :alt="current?.alt ?? ''"
          draggable="false"
          class="max-h-full max-w-full select-none rounded shadow-2xl"
          :class="[
            scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
            dragging ? '' : 'transition-transform duration-100',
          ]"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          @dblclick="toggleZoom"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <div v-else class="flex flex-col items-center gap-2 text-slate-500">
          <UIcon
            :name="state === 'error' ? 'i-lucide-image-off' : 'i-lucide-loader'"
            class="h-8 w-8"
            :class="state === 'error' ? '' : 'animate-spin'"
          />
          <p class="text-[12px]">
            {{ state === 'error' ? 'Failed to load image.' : 'Loading…' }}
          </p>
          <button
            v-if="state === 'error' && current"
            class="text-[12px] text-amber-300 hover:underline"
            @click="props.blobs.retry(current.artifactId)"
          >
            Retry
          </button>
        </div>

        <button
          v-if="total > 1"
          class="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-slate-900/80 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
          title="Next (→)"
          @click="go(1)"
        >
          <UIcon name="i-lucide-chevron-right" class="h-5 w-5" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
