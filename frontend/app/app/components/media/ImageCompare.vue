<script setup lang="ts">
// Actual-vs-reference comparator for one view. Four modes:
//   · side-by-side — the two images in a 2-col grid (the original layout)
//   · overlay      — stacked, with an opacity (onion-skin) slider on the actual layer
//   · swipe        — reference under, actual clipped by a draggable split handle
//   · diff         — canvas `difference` composite (identical pixels go black)
// Modes that need both images hide themselves when there's no reference yet. Clicking any
// image emits `expand` so the owner can open the shared lightbox; the reference slot doubles
// as a drag-and-drop / click upload target (emits `uploadReference`).
import { computed, nextTick, ref, watch } from 'vue'
import type { ArtifactBlobs } from '~/composables/useArtifactBlobs'

const props = defineProps<{
  view: string
  actualId: string | null | undefined
  referenceId: string | null | undefined
  blobs: ArtifactBlobs
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'expand', artifactId: string): void
  (e: 'uploadReference', file: File): void
}>()

type Mode = 'side-by-side' | 'overlay' | 'swipe' | 'diff'

const actualUrl = computed(() => props.blobs.urlFor(props.actualId))
const refUrl = computed(() => props.blobs.urlFor(props.referenceId))
const hasBoth = computed(() => !!actualUrl.value && !!refUrl.value)

const diffFailed = ref(false)
const MODES = computed<{ id: Mode; icon: string; label: string }[]>(() => {
  const base: { id: Mode; icon: string; label: string }[] = [
    { id: 'side-by-side', icon: 'i-lucide-columns-2', label: 'Side by side' },
  ]
  if (hasBoth.value) {
    base.push(
      { id: 'overlay', icon: 'i-lucide-layers', label: 'Overlay' },
      { id: 'swipe', icon: 'i-lucide-flip-horizontal-2', label: 'Swipe' },
    )
    if (!diffFailed.value) base.push({ id: 'diff', icon: 'i-lucide-contrast', label: 'Difference' })
  }
  return base
})

const mode = ref<Mode>('side-by-side')
// Fall back to side-by-side if the active mode stops being available (e.g. reference removed).
watch(MODES, (list) => {
  if (!list.some((m) => m.id === mode.value)) mode.value = 'side-by-side'
})

const overlayOpacity = ref(50)
const splitPct = ref(50)

// --- swipe handle drag ---
const swipeBox = ref<HTMLElement | null>(null)
const swiping = ref(false)
function onSwipeDown(e: PointerEvent) {
  swiping.value = true
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  moveSwipe(e)
}
function moveSwipe(e: PointerEvent) {
  if (!swiping.value || !swipeBox.value) return
  const r = swipeBox.value.getBoundingClientRect()
  splitPct.value = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))
}
function onSwipeUp() {
  swiping.value = false
}

// --- diff canvas ---
const diffCanvas = ref<HTMLCanvasElement | null>(null)
const CAP = 2000
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
async function renderDiff() {
  if (mode.value !== 'diff' || !actualUrl.value || !refUrl.value) return
  await nextTick()
  const canvas = diffCanvas.value
  if (!canvas) return
  try {
    const [a, b] = await Promise.all([loadImage(actualUrl.value), loadImage(refUrl.value)])
    const scale = Math.min(1, CAP / Math.max(a.naturalWidth, a.naturalHeight || 1))
    const w = Math.max(1, Math.round((a.naturalWidth || 1) * scale))
    const h = Math.max(1, Math.round((a.naturalHeight || 1) * scale))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(b, 0, 0, w, h)
    ctx.globalCompositeOperation = 'difference'
    ctx.drawImage(a, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    // Touch the pixels to surface a taint SecurityError early (untainted for same-origin
    // blobs, but degrade gracefully if that ever changes).
    ctx.getImageData(0, 0, 1, 1)
    diffFailed.value = false
  } catch {
    diffFailed.value = true
    if (mode.value === 'diff') mode.value = 'overlay'
  }
}
watch([mode, actualUrl, refUrl], renderDiff, { immediate: true })

// --- reference upload (drag-drop + click) ---
const dragOver = ref(false)
const refInput = ref<HTMLInputElement | null>(null)
function pickFile(files: FileList | null | undefined) {
  const file = files?.[0]
  if (file && file.type.startsWith('image/')) emit('uploadReference', file)
}
function onDrop(e: DragEvent) {
  dragOver.value = false
  pickFile(e.dataTransfer?.files)
}
function onRefInput(e: Event) {
  pickFile((e.target as HTMLInputElement).files)
  if (refInput.value) refInput.value.value = ''
}
</script>

<template>
  <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h3 class="min-w-0 truncate text-[12px] font-semibold text-slate-200">{{ view }}</h3>
      <!-- Mode switch -->
      <div
        v-if="MODES.length > 1"
        class="flex items-center gap-0.5 rounded-md border border-slate-800 bg-slate-950/60 p-0.5"
      >
        <button
          v-for="m in MODES"
          :key="m.id"
          class="rounded px-1.5 py-1 text-slate-400 hover:text-slate-200"
          :class="mode === m.id ? 'bg-slate-800 text-slate-100' : ''"
          :title="m.label"
          @click="mode = m.id"
        >
          <UIcon :name="m.icon" class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- SIDE BY SIDE -->
    <div v-if="mode === 'side-by-side'" class="grid grid-cols-2 gap-3">
      <figure class="space-y-1">
        <figcaption class="text-[10px] uppercase tracking-wide text-slate-500">Actual</figcaption>
        <button
          v-if="actualUrl"
          class="block w-full overflow-hidden rounded border border-slate-800 hover:border-slate-600"
          @click="actualId && emit('expand', actualId)"
        >
          <img :src="actualUrl" :alt="`${view} (actual)`" class="w-full cursor-zoom-in" />
        </button>
        <div
          v-else
          class="flex h-32 items-center justify-center rounded border border-dashed border-slate-700 text-[11px] text-slate-600"
        >
          {{
            props.blobs.statusFor(actualId) === 'error'
              ? 'Failed to load'
              : actualId
                ? 'Loading…'
                : 'Not captured'
          }}
        </div>
      </figure>

      <figure class="space-y-1">
        <figcaption class="text-[10px] uppercase tracking-wide text-slate-500">
          Reference
        </figcaption>
        <button
          v-if="refUrl"
          class="group relative block w-full overflow-hidden rounded border border-slate-800 hover:border-slate-600"
          @click="referenceId && emit('expand', referenceId)"
        >
          <img :src="refUrl" :alt="`${view} (reference)`" class="w-full cursor-zoom-in" />
          <span
            class="absolute bottom-1 right-1 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 group-hover:opacity-100"
            @click.stop="refInput?.click()"
          >
            Replace
          </span>
        </button>
        <!-- Drop zone when no reference yet -->
        <div
          v-else
          class="flex h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded border border-dashed text-[11px] transition"
          :class="
            dragOver
              ? 'border-amber-500 bg-amber-500/5 text-amber-300'
              : 'border-slate-700 text-slate-600 hover:border-slate-500 hover:text-slate-400'
          "
          @click="refInput?.click()"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <UIcon name="i-lucide-image-up" class="h-5 w-5" />
          <span>Drop or click to add a reference</span>
        </div>
      </figure>
    </div>

    <!-- OVERLAY (onion-skin) -->
    <div v-else-if="mode === 'overlay'" class="space-y-2">
      <div class="relative w-full overflow-hidden rounded border border-slate-800">
        <img :src="refUrl" :alt="`${view} (reference)`" class="w-full" />
        <img
          :src="actualUrl"
          :alt="`${view} (actual)`"
          class="absolute inset-0 h-full w-full"
          :style="{ opacity: overlayOpacity / 100 }"
        />
      </div>
      <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
        <span>Reference</span>
        <input
          v-model.number="overlayOpacity"
          type="range"
          min="0"
          max="100"
          class="flex-1 accent-amber-500"
        />
        <span>Actual</span>
      </div>
    </div>

    <!-- SWIPE (split slider) -->
    <div
      v-else-if="mode === 'swipe'"
      ref="swipeBox"
      class="relative w-full cursor-ew-resize select-none overflow-hidden rounded border border-slate-800"
      @pointerdown="onSwipeDown"
      @pointermove="moveSwipe"
      @pointerup="onSwipeUp"
      @pointercancel="onSwipeUp"
    >
      <img :src="refUrl" :alt="`${view} (reference)`" class="block w-full" />
      <div
        class="absolute inset-0 overflow-hidden"
        :style="{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }"
      >
        <img :src="actualUrl" :alt="`${view} (actual)`" class="block w-full" />
      </div>
      <div class="absolute inset-y-0 w-0.5 bg-amber-400" :style="{ left: `${splitPct}%` }">
        <span
          class="absolute top-1/2 left-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-amber-400 text-slate-950 shadow"
        >
          <UIcon name="i-lucide-move-horizontal" class="h-3.5 w-3.5" />
        </span>
      </div>
      <span
        class="absolute left-1 top-1 rounded bg-slate-950/70 px-1 text-[9px] uppercase text-slate-300"
        >Actual</span
      >
      <span
        class="absolute right-1 top-1 rounded bg-slate-950/70 px-1 text-[9px] uppercase text-slate-300"
        >Reference</span
      >
    </div>

    <!-- DIFF (canvas) -->
    <div v-else-if="mode === 'diff'" class="space-y-1">
      <canvas ref="diffCanvas" class="w-full rounded border border-slate-800 bg-black" />
      <p class="text-[10px] text-slate-500">Identical pixels appear black; differences glow.</p>
    </div>

    <!-- Hidden file input shared by replace/drop zone -->
    <input
      ref="refInput"
      type="file"
      accept="image/png,image/jpeg"
      class="hidden"
      :disabled="busy"
      @change="onRefInput"
    />
  </div>
</template>
