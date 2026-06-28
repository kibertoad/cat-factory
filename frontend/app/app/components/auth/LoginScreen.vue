<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'

const auth = useAuthStore()
const { t } = useI18n()

// Local-mode source-control PAT login. GitHub/GitLab are brand names (kept verbatim across
// locales), as are the token-settings URLs, so they're inline constants rather than catalog
// keys — same convention as the provider descriptors in ApiKeysSection. The actual link
// prefers the server's scopes-preselected deep link (`patLogin.setupUrls`); these are the
// fallback when it's absent.
type PatProvider = 'github' | 'gitlab'
const PROVIDER_LABELS: Record<PatProvider, string> = { github: 'GitHub', gitlab: 'GitLab' }
const PROVIDER_ICONS: Record<PatProvider, string> = {
  github: 'i-lucide-github',
  gitlab: 'i-lucide-gitlab',
}
// Fallback token-creation pages, used only if the server didn't advertise a deep link.
const PROVIDER_TOKEN_URLS: Record<PatProvider, string> = {
  github: 'https://github.com/settings/tokens/new',
  gitlab: 'https://gitlab.com/-/user_settings/personal_access_tokens',
}

const patLoginCfg = computed(() => auth.localMode?.patLogin)
const configuredProviders = computed<PatProvider[]>(
  () => (patLoginCfg.value?.configured ?? []) as PatProvider[],
)
const availableProviders = computed<PatProvider[]>(
  () => (patLoginCfg.value?.available ?? []) as PatProvider[],
)
const showLocalLogin = computed(() => availableProviders.value.length > 0)

const patProvider = ref<PatProvider>('github')
const patToken = ref('')
const patBusy = ref(false)
const patError = ref<string | null>(null)

// Keep the picker on an actually-available provider.
watch(
  availableProviders,
  (list) => {
    if (list.length && !list.includes(patProvider.value)) patProvider.value = list[0]!
  },
  { immediate: true },
)

const patProviderItems = computed(() =>
  availableProviders.value.map((p) => ({ label: PROVIDER_LABELS[p], value: p })),
)

// Prefer the server's scopes-preselected deep link (it owns the per-provider scopes);
// fall back to the plain token page if it wasn't advertised.
const tokenCreateUrl = computed(
  () => patLoginCfg.value?.setupUrls?.[patProvider.value] ?? PROVIDER_TOKEN_URLS[patProvider.value],
)

/** One-click (configured PAT) or pasted-token sign-in; reloads so the app boots signed in. */
async function submitPat(provider: PatProvider, token?: string) {
  patError.value = null
  patBusy.value = true
  try {
    await auth.patLogin(token ? { provider, token } : { provider })
    if (typeof window !== 'undefined') window.location.assign(window.location.pathname)
  } catch (e) {
    patError.value = apiErrorEnvelope(e)?.message ?? t('auth.localMode.failed')
  } finally {
    patBusy.value = false
  }
}

// An invite token may ride in on the URL (?invite=…) — it flows through the OAuth
// redirect and the password signup so a brand-new user can join the org on first login.
const invite = computed(() => {
  if (typeof window === 'undefined') return undefined
  return new URLSearchParams(window.location.search).get('invite') || undefined
})

// Password form: signup creates a new user (invite or allowed-email-domain gated),
// login authenticates an existing one, forgot requests a reset link. Default to login;
// flip to signup when invited.
const mode = ref<'login' | 'signup' | 'forgot'>(invite.value ? 'signup' : 'login')
const email = ref('')
const password = ref('')
const name = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
// Set once a reset link has been requested, so we can show a generic confirmation
// (we never reveal whether the email is registered).
const forgotSent = ref(false)

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
      apiErrorEnvelope(e)?.message ?? 'Sign-in failed. Check your details and try again.'
  } finally {
    busy.value = false
  }
}

async function submitForgot() {
  error.value = null
  busy.value = true
  try {
    await auth.forgotPassword(email.value)
    forgotSent.value = true
  } catch {
    // The request endpoint is generic by design; only an infra error lands here.
    error.value = 'Something went wrong. Please try again.'
  } finally {
    busy.value = false
  }
}

/** Switch modes, clearing any transient form state. */
function setMode(next: 'login' | 'signup' | 'forgot') {
  mode.value = next
  error.value = null
  forgotSent.value = false
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
          <template v-if="mode === 'forgot'">Reset your password.</template>
          <template v-else>{{
            invite ? 'Accept your invitation to continue.' : 'Sign in to continue.'
          }}</template>
        </p>
      </div>

      <!-- Local mode: sign in with a source-control PAT (no OAuth round-trip needed) -->
      <div v-if="showLocalLogin && mode !== 'forgot'" class="space-y-3">
        <!-- One-click: a PAT is already configured server-side -->
        <UButton
          v-for="p in configuredProviders"
          :key="p"
          block
          size="lg"
          color="primary"
          :icon="PROVIDER_ICONS[p]"
          :loading="patBusy"
          @click="submitPat(p)"
        >
          {{ t('auth.localMode.continueWith', { provider: PROVIDER_LABELS[p] }) }}
        </UButton>

        <!-- Enter a PAT inline -->
        <form class="space-y-2" @submit.prevent="submitPat(patProvider, patToken.trim())">
          <p class="text-xs font-medium text-slate-400">{{ t('auth.localMode.enterPatTitle') }}</p>
          <USelect
            v-if="patProviderItems.length > 1"
            v-model="patProvider"
            :items="patProviderItems"
            size="lg"
            class="w-full"
          />
          <UTextarea
            v-model="patToken"
            :rows="2"
            :placeholder="
              t('auth.localMode.tokenPlaceholder', { provider: PROVIDER_LABELS[patProvider] })
            "
            class="w-full font-mono"
          />
          <div class="flex items-center justify-between gap-2">
            <a
              :href="tokenCreateUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-indigo-400 hover:underline"
            >
              {{ t('auth.localMode.createToken', { provider: PROVIDER_LABELS[patProvider] }) }}
            </a>
            <UButton
              size="lg"
              color="neutral"
              variant="subtle"
              type="submit"
              :loading="patBusy"
              :disabled="!patToken.trim()"
            >
              {{ t('auth.localMode.submit') }}
            </UButton>
          </div>
        </form>
        <p v-if="patError" class="text-sm text-rose-400">{{ patError }}</p>
      </div>

      <div
        v-if="showLocalLogin && auth.providers.password && mode !== 'forgot'"
        class="my-4 flex items-center gap-3 text-xs text-slate-500"
      >
        <span class="h-px flex-1 bg-slate-800" /> {{ t('auth.localMode.orDivider') }}
        <span class="h-px flex-1 bg-slate-800" />
      </div>

      <!-- OAuth providers -->
      <div v-if="mode !== 'forgot'" class="space-y-2">
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

      <div
        v-if="showOAuthDivider && mode !== 'forgot'"
        class="my-4 flex items-center gap-3 text-xs text-slate-500"
      >
        <span class="h-px flex-1 bg-slate-800" /> or <span class="h-px flex-1 bg-slate-800" />
      </div>

      <!-- Email / password -->
      <form
        v-if="auth.providers.password && mode !== 'forgot'"
        class="space-y-3"
        @submit.prevent="submitPassword"
      >
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
            <button
              type="button"
              class="text-indigo-400 hover:underline"
              @click="setMode('signup')"
            >
              Sign up
            </button>
          </template>
          <template v-else>
            Already have an account?
            <button type="button" class="text-indigo-400 hover:underline" @click="setMode('login')">
              Sign in
            </button>
          </template>
        </p>
        <p v-if="mode === 'login'" class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="setMode('forgot')">
            Forgot password?
          </button>
        </p>
      </form>

      <!-- Forgot password: request a reset link by email -->
      <form
        v-if="auth.providers.password && mode === 'forgot'"
        class="space-y-3"
        @submit.prevent="submitForgot"
      >
        <template v-if="forgotSent">
          <p class="text-sm text-slate-300">
            If an account exists for that email, a password reset link is on its way. Check your
            inbox.
          </p>
        </template>
        <template v-else>
          <UInput
            v-model="email"
            type="email"
            required
            placeholder="Email"
            icon="i-lucide-at-sign"
            size="lg"
            class="w-full"
          />
          <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
          <UButton block size="lg" color="primary" type="submit" :loading="busy">
            Send reset link
          </UButton>
        </template>
        <p class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="setMode('login')">
            Back to sign in
          </button>
        </p>
      </form>
    </div>
  </div>
</template>
