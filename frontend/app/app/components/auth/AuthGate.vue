<script setup lang="ts">
import { computed } from 'vue'
import BackendMisconfiguredScreen from '~/components/auth/BackendMisconfiguredScreen.vue'
import LoginScreen from '~/components/auth/LoginScreen.vue'

// Resolves auth state once on mount, then either renders the app (auth off, or
// on with a signed-in user) or the login screen. The board's own bootstrap runs
// inside the default slot, so it only fires once the user is allowed in.
const auth = useAuthStore()
const route = useRoute()
const { t } = useI18n()

// The password-reset page is public: a recipient of an emailed reset link is signed
// out, so it must render even when auth is required and there's no user.
const isPublicRoute = computed(() => route.path === '/reset-password')

// Stamp the first cold-open milestone once the auth handshake settles (app-startup initiative,
// item 1) — bootstrap resolves even on failure (it catches internally), so `finally` always fires.
onMounted(() => void auth.bootstrap().finally(() => markBoot('auth-ready')))
</script>

<template>
  <div
    v-if="!auth.ready"
    class="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-slate-950 text-slate-400"
  >
    <UIcon name="i-lucide-loader" class="h-8 w-8 animate-spin" />
    <span class="text-sm">{{ t('auth.gate.loading') }}</span>
  </div>

  <BackendMisconfiguredScreen v-else-if="auth.isMisconfigured" />

  <slot v-else-if="isPublicRoute" />

  <LoginScreen v-else-if="auth.needsLogin" />

  <slot v-else />
</template>
