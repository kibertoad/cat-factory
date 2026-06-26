<script setup lang="ts">
import { computed, ref } from 'vue'

// Standalone full-screen reset form reached from the emailed link
// (`/reset-password?token=…`). It is a public route (see AuthGate), so a recipient who
// is signed out can still set a new password. On success we send them to the login.
const auth = useAuthStore()

const token = computed(() => {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('token') || ''
})

const password = ref('')
const confirm = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const done = ref(false)

async function submit() {
  error.value = null
  if (password.value.length < 8) {
    error.value = 'Password must be at least 8 characters.'
    return
  }
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match.'
    return
  }
  busy.value = true
  try {
    await auth.resetPassword(token.value, password.value)
    done.value = true
  } catch (e) {
    error.value =
      (e as { data?: { error?: { message?: string } } })?.data?.error?.message ??
      'This password reset link is invalid or has expired.'
  } finally {
    busy.value = false
  }
}

function goToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/')
}
</script>

<template>
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
    <div
      class="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <div class="mb-6 text-center">
        <UIcon name="i-lucide-key-round" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">Reset password</h1>
        <p class="text-sm text-slate-400">Choose a new password for your account.</p>
      </div>

      <template v-if="done">
        <p class="mb-4 text-sm text-slate-300">
          Your password has been reset. You can now sign in with your new password.
        </p>
        <UButton block size="lg" color="primary" @click="goToLogin">Go to sign in</UButton>
      </template>

      <template v-else-if="!token">
        <p class="mb-4 text-sm text-rose-400">
          This reset link is missing its token. Request a new link from the sign-in screen.
        </p>
        <UButton block size="lg" color="neutral" variant="subtle" @click="goToLogin">
          Back to sign in
        </UButton>
      </template>

      <form v-else class="space-y-3" @submit.prevent="submit">
        <UInput
          v-model="password"
          type="password"
          required
          placeholder="New password"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <UInput
          v-model="confirm"
          type="password"
          required
          placeholder="Confirm new password"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
        <UButton block size="lg" color="primary" type="submit" :loading="busy">
          Reset password
        </UButton>
        <p class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="goToLogin">
            Back to sign in
          </button>
        </p>
      </form>
    </div>
  </div>
</template>
