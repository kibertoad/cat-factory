<script setup lang="ts">
import { computed, ref } from 'vue'
import SecretInput from '~/components/common/SecretInput.vue'

// Standalone full-screen reset form reached from the emailed link
// (`/reset-password?token=…`). It is a public route (see AuthGate), so a recipient who
// is signed out can still set a new password. On success we send them to the login.
const auth = useAuthStore()
const { t } = useI18n()

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
    error.value = t('auth.resetPassword.errorTooShort')
    return
  }
  if (password.value !== confirm.value) {
    error.value = t('auth.resetPassword.errorMismatch')
    return
  }
  busy.value = true
  try {
    await auth.resetPassword(token.value, password.value)
    done.value = true
  } catch (e) {
    error.value =
      (e as { data?: { error?: { message?: string } } })?.data?.error?.message ??
      t('auth.resetPassword.errorInvalidLink')
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
        <h1 class="mb-1 text-lg font-semibold text-white">{{ t('auth.resetPassword.title') }}</h1>
        <p class="text-sm text-slate-400">{{ t('auth.resetPassword.subtitle') }}</p>
      </div>

      <template v-if="done">
        <p class="mb-4 text-sm text-slate-300">
          {{ t('auth.resetPassword.doneBody') }}
        </p>
        <UButton block size="lg" color="primary" @click="goToLogin">{{
          t('auth.resetPassword.goToSignIn')
        }}</UButton>
      </template>

      <template v-else-if="!token">
        <p class="mb-4 text-sm text-rose-400">
          {{ t('auth.resetPassword.missingToken') }}
        </p>
        <UButton block size="lg" color="neutral" variant="subtle" @click="goToLogin">
          {{ t('auth.resetPassword.backToSignIn') }}
        </UButton>
      </template>

      <form v-else class="space-y-3" @submit.prevent="submit">
        <SecretInput
          v-model="password"
          required
          :placeholder="t('auth.resetPassword.newPasswordPlaceholder')"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <SecretInput
          v-model="confirm"
          required
          :placeholder="t('auth.resetPassword.confirmPasswordPlaceholder')"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
        <UButton block size="lg" color="primary" type="submit" :loading="busy">
          {{ t('auth.resetPassword.submit') }}
        </UButton>
        <p class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="goToLogin">
            {{ t('auth.resetPassword.backToSignIn') }}
          </button>
        </p>
      </form>
    </div>
  </div>
</template>
