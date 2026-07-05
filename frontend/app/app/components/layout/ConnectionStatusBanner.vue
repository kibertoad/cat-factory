<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

// A slim top strip shown when the real-time WebSocket isn't delivering events, so a
// silently-frozen board (events stop arriving, nothing updates) is no longer indistinguishable
// from an idle one. Two states:
//   - RE-connecting: we were live and the socket dropped (`useWorkspaceStream` reconnects with
//     exponential backoff and resyncs on reconnect — this just makes that state visible).
//   - Offline: the very first handshake keeps failing (`connectionFailed`), so the board loaded
//     over REST but will never go live — a user watching a run would otherwise see a frozen
//     board with no hint why.
// The `connected` / `everConnected` / `connectionFailed` refs are passed in as props (the page
// owns the single stream instance; creating another here would open a second socket).
const props = defineProps<{
  connected: boolean
  everConnected: boolean
  connectionFailed: boolean
}>()

const { t } = useI18n()

// A short debounce rides out a quick socket flap so a momentary blip doesn't flash the strip.
const showAfterDelay = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

watch(
  () => props.connected,
  (connected) => {
    if (connected) {
      showAfterDelay.value = false
      clearTimer()
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      showAfterDelay.value = true
      timer = null
    }, 1500)
  },
  { immediate: true },
)

// Reconnection: only surface once we've been connected — a later drop is a real interruption.
const reconnecting = computed(() => props.everConnected && !props.connected && showAfterDelay.value)
// Offline: never connected and repeated attempts failed. No debounce — it already took several
// backoff cycles to flag, so it's not a flap.
const offline = computed(() => props.connectionFailed && !props.connected && !props.everConnected)

// Don't leave a pending debounce timer firing into a torn-down component.
onBeforeUnmount(clearTimer)
</script>

<template>
  <Transition name="fade">
    <div
      v-if="reconnecting || offline"
      class="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-2"
    >
      <div
        v-if="reconnecting"
        class="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/60 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur"
        role="status"
        aria-live="polite"
        data-testid="stream-reconnecting"
      >
        <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin" />
        <span>{{ t('app.reconnecting') }}</span>
      </div>
      <div
        v-else
        class="pointer-events-auto flex items-center gap-2 rounded-full border border-rose-500/60 bg-rose-950/90 px-3 py-1.5 text-xs text-rose-100 shadow-lg backdrop-blur"
        role="status"
        aria-live="polite"
        data-testid="stream-offline"
      >
        <UIcon name="i-lucide-wifi-off" class="h-3.5 w-3.5" />
        <span>{{ t('app.offline') }}</span>
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
