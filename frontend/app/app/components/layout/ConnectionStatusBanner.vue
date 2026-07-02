<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

// A slim top strip shown when the real-time WebSocket has dropped and is reconnecting, so a
// silently-frozen board (events stop arriving, nothing updates) is no longer indistinguishable
// from an idle one. `useWorkspaceStream` already reconnects with exponential backoff and
// resyncs on reconnect — this only makes that state visible. The `connected` ref is passed in
// as a prop (the page owns the single stream instance; creating another here would open a
// second socket).
const props = defineProps<{ connected: boolean }>()

const { t } = useI18n()

// Only surface a RE-connection, never the initial connect: once we've been connected we know a
// later drop is a real interruption worth flagging. A short debounce rides out a quick socket
// flap so a momentary blip doesn't flash the strip.
const everConnected = ref(false)
const showAfterDelay = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.connected,
  (connected) => {
    if (connected) {
      everConnected.value = true
      showAfterDelay.value = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return
    }
    if (!everConnected.value || timer) return
    timer = setTimeout(() => {
      showAfterDelay.value = true
      timer = null
    }, 1500)
  },
  { immediate: true },
)

const visible = computed(() => everConnected.value && !props.connected && showAfterDelay.value)

// Don't leave a pending debounce timer firing into a torn-down component.
onBeforeUnmount(() => {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
})
</script>

<template>
  <Transition name="fade">
    <div
      v-if="visible"
      class="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-2"
    >
      <div
        class="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/60 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur"
        role="status"
        aria-live="polite"
        data-testid="stream-reconnecting"
      >
        <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin" />
        <span>{{ t('app.reconnecting') }}</span>
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
