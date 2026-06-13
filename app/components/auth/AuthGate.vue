<script setup lang="ts">
import LoginScreen from '~/components/auth/LoginScreen.vue'

// Resolves auth state once on mount, then either renders the app (auth off, or
// on with a signed-in user) or the login screen. The board's own bootstrap runs
// inside the default slot, so it only fires once the user is allowed in.
const auth = useAuthStore()

onMounted(() => auth.bootstrap())
</script>

<template>
  <div
    v-if="!auth.ready"
    class="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-slate-950 text-slate-400"
  >
    <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
    <span class="text-sm">Loading…</span>
  </div>

  <LoginScreen v-else-if="auth.required && !auth.user" />

  <slot v-else />
</template>
