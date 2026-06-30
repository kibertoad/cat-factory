<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'

const auth = useAuthStore()
const { t } = useI18n()

// Local-mode source-control PAT login. The PAT lives server-side in env (GITHUB_PAT /
// GITLAB_PAT); the login screen only SELECTS a configured provider — no token is ever typed
// into or shown in the browser. GitHub/GitLab are brand names (kept verbatim across locales),
// as are the token-settings URLs, so they're inline constants rather than catalog keys — same
// convention as the provider descriptors in ApiKeysSection. The "create a token" link prefers
// the server's scopes-preselected deep link (`patLogin.setupUrls`); these are the fallback.
type PatProvider = 'github' | 'gitlab'
const ALL_PROVIDERS: PatProvider[] = ['github', 'gitlab']
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
// Only providers whose PAT is configured in env can sign in (the token is the operational
// credential too). A provider without one gets no button — see the no-PAT notice instead.
const configuredProviders = computed<PatProvider[]>(
  () => (patLoginCfg.value?.configured ?? []) as PatProvider[],
)
const isLocalMode = computed(() => auth.localMode?.enabled === true)
const hasConfiguredPat = computed(() => configuredProviders.value.length > 0)

const patBusy = ref(false)
const patError = ref<string | null>(null)

// Per-provider "create a token" link: prefer the server's scopes-preselected deep link (it
// owns the per-provider scopes), fall back to the plain token page.
function tokenCreateUrl(provider: PatProvider): string {
  return patLoginCfg.value?.setupUrls?.[provider] ?? PROVIDER_TOKEN_URLS[provider]
}

/** Sign in as the account the configured env PAT belongs to; reloads so the app boots in. */
async function submitPat(provider: PatProvider) {
  patError.value = null
  patBusy.value = true
  try {
    await auth.patLogin({ provider })
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
    error.value = apiErrorEnvelope(e)?.message ?? t('auth.login.signInFailed')
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
    error.value = t('auth.login.genericError')
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

// Hosted (remote node) PAT login: the user pastes their OWN source-control PAT, which the
// server resolves to an account and holds to its login/org/domain allowlist. The available
// providers come from the server (`auth.patProviders`); empty in local mode (which uses the
// configured-token flow above) and on OAuth-only facades like the Worker.
const remotePatProviders = computed<PatProvider[]>(() =>
  isLocalMode.value ? [] : (auth.patProviders as PatProvider[]),
)
const remotePatProvider = ref<PatProvider>('github')
watch(
  remotePatProviders,
  (list) => {
    if (list.length && !list.includes(remotePatProvider.value)) remotePatProvider.value = list[0]!
  },
  { immediate: true },
)
const remotePatToken = ref('')
const remotePatBusy = ref(false)
const remotePatError = ref<string | null>(null)

async function submitRemotePat() {
  remotePatError.value = null
  remotePatBusy.value = true
  try {
    await auth.patLogin({ provider: remotePatProvider.value, token: remotePatToken.value.trim() })
    if (typeof window !== 'undefined') window.location.assign(window.location.pathname)
  } catch (e) {
    remotePatError.value = apiErrorEnvelope(e)?.message ?? t('auth.login.signInFailed')
  } finally {
    remotePatBusy.value = false
  }
}

// A remote deployment (node service / Worker) that advertises no sign-in method at all:
// no OAuth, no password, no PAT, and not local mode. The auth gate still routes here (a
// remote facade has no anonymous tier), so instead of a blank card we explain that
// authentication isn't configured and there's nothing to sign in with yet.
const noSignInMethod = computed(
  () =>
    !isLocalMode.value &&
    !auth.providers.github &&
    !auth.providers.google &&
    !auth.providers.password &&
    remotePatProviders.value.length === 0,
)
</script>

<template>
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
    <div
      class="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <div class="mb-6 text-center">
        <UIcon name="i-lucide-layout-dashboard" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">{{ t('auth.login.appTitle') }}</h1>
        <p class="text-sm text-slate-400">
          <template v-if="mode === 'forgot'">{{ t('auth.login.forgotSubtitle') }}</template>
          <template v-else>{{
            invite ? t('auth.login.inviteSubtitle') : t('auth.login.subtitle')
          }}</template>
        </p>
      </div>

      <!-- Local mode: sign in with the env-configured source-control PAT. The token lives
           server-side (GITHUB_PAT / GITLAB_PAT); we only pick a provider here. -->
      <div v-if="isLocalMode && mode !== 'forgot'" class="space-y-3">
        <!-- One button per provider whose PAT is configured in env -->
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
          {{ t('auth.localMode.continueWithConfigured', { provider: PROVIDER_LABELS[p] }) }}
        </UButton>

        <!-- Neither GITHUB_PAT nor GITLAB_PAT is set: tell the developer how to configure one -->
        <template v-if="!hasConfiguredPat">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-key-round"
            :title="t('auth.localMode.noPatTitle')"
            :description="t('auth.localMode.noPatBody')"
          />
          <div class="flex flex-wrap gap-3 px-1">
            <a
              v-for="p in ALL_PROVIDERS"
              :key="p"
              :href="tokenCreateUrl(p)"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-indigo-400 hover:underline"
            >
              {{ t('auth.localMode.createToken', { provider: PROVIDER_LABELS[p] }) }}
            </a>
          </div>
        </template>

        <p v-if="patError" class="text-sm text-rose-400">{{ patError }}</p>
      </div>

      <div
        v-if="isLocalMode && auth.providers.password && mode !== 'forgot'"
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
          {{ t('auth.login.continueWithGithub') }}
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
          {{ t('auth.login.continueWithGoogle') }}
        </UButton>
      </div>

      <div
        v-if="showOAuthDivider && mode !== 'forgot'"
        class="my-4 flex items-center gap-3 text-xs text-slate-500"
      >
        <span class="h-px flex-1 bg-slate-800" /> {{ t('auth.login.or') }}
        <span class="h-px flex-1 bg-slate-800" />
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
          :placeholder="t('auth.login.namePlaceholder')"
          icon="i-lucide-user"
          size="lg"
          class="w-full"
        />
        <UInput
          v-model="email"
          type="email"
          required
          :placeholder="t('auth.login.emailPlaceholder')"
          icon="i-lucide-at-sign"
          size="lg"
          class="w-full"
        />
        <UInput
          v-model="password"
          type="password"
          required
          :placeholder="t('auth.login.passwordPlaceholder')"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
        />
        <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
        <UButton block size="lg" color="primary" type="submit" :loading="busy">
          {{ mode === 'signup' ? t('auth.login.createAccount') : t('auth.login.signIn') }}
        </UButton>
        <p class="text-center text-xs text-slate-400">
          <template v-if="mode === 'login'">
            <i18n-t keypath="auth.login.needAccount" tag="span" scope="global">
              <template #signUp>
                <button
                  type="button"
                  class="text-indigo-400 hover:underline"
                  @click="setMode('signup')"
                >
                  {{ t('auth.login.signUp') }}
                </button>
              </template>
            </i18n-t>
          </template>
          <template v-else>
            <i18n-t keypath="auth.login.haveAccount" tag="span" scope="global">
              <template #signIn>
                <button
                  type="button"
                  class="text-indigo-400 hover:underline"
                  @click="setMode('login')"
                >
                  {{ t('auth.login.signIn') }}
                </button>
              </template>
            </i18n-t>
          </template>
        </p>
        <p v-if="mode === 'login'" class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="setMode('forgot')">
            {{ t('auth.login.forgotPassword') }}
          </button>
        </p>
      </form>

      <!-- Hosted (remote node) PAT login: paste your own source-control PAT -->
      <template v-if="remotePatProviders.length > 0 && mode !== 'forgot'">
        <div
          v-if="auth.providers.github || auth.providers.google || auth.providers.password"
          class="my-4 flex items-center gap-3 text-xs text-slate-500"
        >
          <span class="h-px flex-1 bg-slate-800" /> {{ t('auth.login.or') }}
          <span class="h-px flex-1 bg-slate-800" />
        </div>
        <form class="space-y-3" @submit.prevent="submitRemotePat">
          <div v-if="remotePatProviders.length > 1" class="flex gap-2">
            <UButton
              v-for="p in remotePatProviders"
              :key="p"
              :color="p === remotePatProvider ? 'primary' : 'neutral'"
              :variant="p === remotePatProvider ? 'solid' : 'subtle'"
              :icon="PROVIDER_ICONS[p]"
              size="sm"
              @click="remotePatProvider = p"
            >
              {{ PROVIDER_LABELS[p] }}
            </UButton>
          </div>
          <UInput
            v-model="remotePatToken"
            type="password"
            required
            :placeholder="
              t('auth.login.patPlaceholder', { provider: PROVIDER_LABELS[remotePatProvider] })
            "
            icon="i-lucide-key-round"
            size="lg"
            class="w-full"
          />
          <p v-if="remotePatError" class="text-sm text-rose-400">{{ remotePatError }}</p>
          <UButton
            block
            size="lg"
            color="primary"
            type="submit"
            :icon="PROVIDER_ICONS[remotePatProvider]"
            :loading="remotePatBusy"
          >
            {{ t('auth.login.signInWithPat', { provider: PROVIDER_LABELS[remotePatProvider] }) }}
          </UButton>
          <p class="px-1 text-center">
            <a
              :href="tokenCreateUrl(remotePatProvider)"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-indigo-400 hover:underline"
            >
              {{
                t('auth.localMode.createToken', { provider: PROVIDER_LABELS[remotePatProvider] })
              }}
            </a>
          </p>
        </form>
      </template>

      <!-- No sign-in method configured on a remote deployment: explain, don't show a blank card -->
      <UAlert
        v-if="noSignInMethod"
        color="warning"
        variant="subtle"
        icon="i-lucide-shield-alert"
        :title="t('auth.login.notConfiguredTitle')"
        :description="t('auth.login.notConfiguredBody')"
      />

      <!-- Forgot password: request a reset link by email -->
      <form
        v-if="auth.providers.password && mode === 'forgot'"
        class="space-y-3"
        @submit.prevent="submitForgot"
      >
        <template v-if="forgotSent">
          <p class="text-sm text-slate-300">
            {{ t('auth.login.forgotSent') }}
          </p>
        </template>
        <template v-else>
          <UInput
            v-model="email"
            type="email"
            required
            :placeholder="t('auth.login.emailPlaceholder')"
            icon="i-lucide-at-sign"
            size="lg"
            class="w-full"
          />
          <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
          <UButton block size="lg" color="primary" type="submit" :loading="busy">
            {{ t('auth.login.sendResetLink') }}
          </UButton>
        </template>
        <p class="text-center text-xs text-slate-400">
          <button type="button" class="text-indigo-400 hover:underline" @click="setMode('login')">
            {{ t('auth.login.backToSignIn') }}
          </button>
        </p>
      </form>
    </div>
  </div>
</template>
