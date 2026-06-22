<script setup lang="ts">
import { computed, ref } from 'vue'

const auth = useAuthStore()

// An invite token may ride in on the URL (?invite=…) — it flows through the OAuth
// redirect and the password signup so a brand-new user can join the org on first login.
const invite = computed(() => {
  if (typeof window === 'undefined') return undefined
  return new URLSearchParams(window.location.search).get('invite') || undefined
})

// Password form: signup creates a new user (invite or allowed-email-domain gated),
// login authenticates an existing one. Default to login; flip to signup when invited.
const mode = ref<'login' | 'signup'>(invite.value ? 'signup' : 'login')
const email = ref('')
const password = ref('')
const name = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submitPassword() {
  error.value = null
  busy.value = true
  try {
    if (mode.value === 'signup') {
      await auth.signup({
        email: email.value,
        password: password.value,
        name: name.value || undefined,
        invite: invite.value,
      })
    } else {
      await auth.passwordLogin({ email: email.value, password: password.value })
    }
    // Reload so the app boots with the new session.
    if (typeof window !== 'undefined') window.location.assign(window.location.pathname)
  } catch (e) {
    error.value =
      (e as { data?: { error?: { message?: string } } })?.data?.error?.message ??
      'Sign-in failed. Check your details and try again.'
  } finally {
    busy.value = false
  }
}

const showOAuthDivider = computed(
  () => auth.providers.password && (auth.providers.github || auth.providers.google),
)
</script>

<template>
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
    <div
      class="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <div class="mb-6 text-center">
        <UIcon name="i-lucide-layout-dashboard" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">Architecture Board</h1>
        <p class="text-sm text-slate-400">
          {{ invite ? 'Accept your invitation to continue.' : 'Sign in to continue.' }}
        </p>
      </div>

      <!-- OAuth providers -->
      <div class="space-y-2">
        <UButton
          v-if="auth.providers.github"
          block
          size="lg"
          color="primary"
          icon="i-lucide-github"
          @click="auth.login(invite)"
        >
          Continue with GitHub
        </UButton>
        <UButton
          v-if="auth.providers.google"
          block
          size="lg"
          color="neutral"
          variant="subtle"
          icon="i-lucide-mail"
          @click="auth.loginWithGoogle(invite)"
        >
          Continue with Google
        </UButton>
      </div>

      <div v-if="showOAuthDivider" class="my-4 flex items-center gap-3 text-xs text-slate-500">
        <span class="h-px flex-1 bg-slate-800" /> or <span class="h-px flex-1 bg-slate-800" />
      </div>

      <!-- Email / password -->
      <form v-if="auth.providers.password" class="space-y-3" @submit.prevent="submitPassword">
        <UInput
          v-if="mode === 'signup'"
          v-model="name"
          placeholder="Name (optional)"
          icon="i-lucide-user"
          size="lg"
          class="w-full"
        />
        <UInput
          v-model="email"
          type="email"
          required
          placeholder="Email"
          icon="i-lucide-at-sign"
          size="lg"
          class="w-full"
        />
        <UInput
          v-model="password"
          type="password"
          required
          placeholder="Password"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
        <UButton block size="lg" color="primary" type="submit" :loading="busy">
          {{ mode === 'signup' ? 'Create account' : 'Sign in' }}
        </UButton>
        <p class="text-center text-xs text-slate-400">
          <template v-if="mode === 'login'">
            Need an account?
            <button type="button" class="text-indigo-400 hover:underline" @click="mode = 'signup'">
              Sign up
            </button>
          </template>
          <template v-else>
            Already have an account?
            <button type="button" class="text-indigo-400 hover:underline" @click="mode = 'login'">
              Sign in
            </button>
          </template>
        </p>
      </form>
    </div>
  </div>
</template>
