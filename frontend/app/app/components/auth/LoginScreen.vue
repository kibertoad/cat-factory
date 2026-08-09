<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import SecretInput from '~/components/common/SecretInput.vue'
import type { VcsProvider } from '~/types/domain'
import { VCS_PROVIDER_ICONS, VCS_PROVIDER_LABELS, vcsTokenCreateUrl } from '~/utils/vcs'
import { SSO_ERROR_MESSAGE_KEYS } from '~/utils/sso'

const auth = useAuthStore()
const { t } = useI18n()

// Local-mode source-control PAT login. A configured token lives server-side and is selected by
// PROVIDER (no token is typed into the browser); a deployment that holds none can be handed one
// here, and it becomes both this sign-in and the credential the deployment operates with. The
// brand labels / icons / token-settings URLs are the shared provider descriptors in `~/utils/vcs`
// (brand names stay verbatim across locales, so they are constants rather than catalog keys — the
// same convention as ApiKeysSection). The "create a token" link prefers the server's
// scopes-preselected deep link (`patLogin.setupUrls`); the descriptor's URL is the fallback.
type PatProvider = VcsProvider
/** Every provider a token page exists for — the fallback link set when none can be installed. */
const ALL_PROVIDERS: PatProvider[] = ['github', 'gitlab']
const PROVIDER_LABELS = VCS_PROVIDER_LABELS
const PROVIDER_ICONS = VCS_PROVIDER_ICONS
// Sign-in happens before any workspace is connected, so there is no host to read: these fall
// back to the provider's public instance. The server's scopes-preselected `setupUrls` win when
// the deployment supplies them.
const PROVIDER_TOKEN_URLS: Record<PatProvider, string> = {
  github: vcsTokenCreateUrl('github'),
  gitlab: vcsTokenCreateUrl('gitlab'),
}

const patLoginCfg = computed(() => auth.localMode?.patLogin)
// Providers whose token the deployment already holds: one-click sign-in. A provider without one
// gets no button — it is offered in the paste form below instead.
const configuredProviders = computed<PatProvider[]>(
  () => (patLoginCfg.value?.configured ?? []) as PatProvider[],
)
// Providers the server will ACCEPT a token for from here. Empty when `.env` owns the credential
// (it wins, so a pasted token would be ignored) or nothing can seal one — the notice then falls
// back to telling the developer where the token actually has to go.
const installableProviders = computed<PatProvider[]>(
  () => (patLoginCfg.value?.installable ?? []) as PatProvider[],
)
const isLocalMode = computed(() => auth.localMode?.enabled === true)
const hasConfiguredPat = computed(() => configuredProviders.value.length > 0)
// Mothership mode: identity + org data live on a hosted mothership, so the primary sign-in is a
// round-trip to the mothership's OAuth (the node then exchanges the session for a machine token).
const isMothership = computed(() => auth.localMode?.mothership === true)

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

// Enterprise SSO. Led with, above the consumer providers, because on a deployment that configures
// it that is the intended way in — a person arriving at an org's board should not have to find
// their company's button under two they must not use. The label is the operator's own wording
// (it names their IdP), so it is rendered verbatim rather than through the catalog.
const ssoLabel = computed(() => auth.sso?.label ?? '')
// Translated copy for a refused round-trip, keyed off the machine-readable reason the backend
// handed back. Each reason has its own wording because the remedies differ: a missing directory
// group is something the user takes to IT, a failed code exchange is the operator's own config.
const ssoErrorMessage = computed(() =>
  auth.ssoError ? t(SSO_ERROR_MESSAGE_KEYS[auth.ssoError]) : null,
)

// Paste-a-token sign-in. The user supplies a source-control PAT and the server resolves it to an
// account. What it MEANS differs per facade, which is why the providers come from two places:
//  - hosted (remote node): the user's OWN token, held to the login/org/domain allowlist. GitHub
//    always, GitLab when configured, on both hosted facades (Node + Worker).
//  - local: the token also becomes the DEPLOYMENT's credential, so the server names the providers
//    it will accept one for (`installable`) — empty once `.env` owns it.
// One form serves both; the local-only hint below says what the token is additionally used for.
const remotePatProviders = computed<PatProvider[]>(() =>
  isLocalMode.value ? installableProviders.value : (auth.patProviders as PatProvider[]),
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

// Only divide SSO from what follows when something actually follows it.
const showSsoDivider = computed(
  () =>
    auth.providers.sso &&
    (auth.providers.github ||
      auth.providers.google ||
      auth.providers.password ||
      remotePatProviders.value.length > 0),
)

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
    !auth.providers.sso &&
    remotePatProviders.value.length === 0,
)
</script>

<template>
  <div
    class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100"
    data-testid="login-screen"
  >
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

      <!-- Mothership mode: sign in through the hosted mothership (it owns identity + the
           allowlist). The node exchanges the returned session for a machine token. -->
      <div v-if="isMothership && mode !== 'forgot'" class="mb-4 space-y-2">
        <UButton
          block
          size="lg"
          color="primary"
          icon="i-lucide-cloud"
          data-testid="mothership-signin"
          @click="auth.signInViaMothership()"
        >
          {{ t('auth.mothership.signIn') }}
        </UButton>
        <p class="px-1 text-xs text-slate-400">{{ t('auth.mothership.hint') }}</p>
        <p
          v-if="auth.mothershipError"
          class="px-1 text-xs text-rose-400"
          data-testid="mothership-error"
        >
          {{ t('auth.mothership.error') }}
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

        <!-- The deployment holds no token. When one can be installed from here the notice says
             so and the create-token links feed the form below; when it can't (`.env` owns the
             credential, or nothing can seal one) it names where the token has to go instead. -->
        <template v-if="!hasConfiguredPat">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-key-round"
            :title="t('auth.localMode.noPatTitle')"
            :description="
              installableProviders.length > 0
                ? t('auth.localMode.setupBody')
                : t('auth.localMode.noPatBody')
            "
          />
          <!-- Only when nothing can be installed here: the paste form below carries its own
               per-provider link, so showing these too would offer the same thing twice. -->
          <div v-if="installableProviders.length === 0" class="flex flex-wrap gap-3 px-1">
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

      <!-- A refused SSO round-trip: name the rule that refused, don't return the user to an
           unchanged sign-in button. -->
      <UAlert
        v-if="ssoErrorMessage && mode !== 'forgot'"
        class="mb-4"
        color="error"
        variant="subtle"
        icon="i-lucide-shield-x"
        :title="t('auth.sso.failedTitle')"
        :description="ssoErrorMessage"
        data-testid="sso-error"
      />

      <!-- Enterprise SSO: the deployment's OWN identity provider, led with where configured. -->
      <div v-if="auth.providers.sso && mode !== 'forgot'" class="mb-2 space-y-2">
        <UButton
          block
          size="lg"
          color="primary"
          icon="i-lucide-building-2"
          data-testid="sso-signin"
          @click="auth.loginWithSso(invite)"
        >
          {{ t('auth.sso.continueWith', { provider: ssoLabel }) }}
        </UButton>
      </div>

      <div
        v-if="showSsoDivider && mode !== 'forgot'"
        class="my-4 flex items-center gap-3 text-xs text-slate-500"
      >
        <span class="h-px flex-1 bg-slate-800" /> {{ t('auth.login.or') }}
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
          data-testid="login-email"
        />
        <SecretInput
          v-model="password"
          required
          :placeholder="t('auth.login.passwordPlaceholder')"
          icon="i-lucide-lock"
          size="lg"
          class="w-full"
          data-testid="login-password"
        />
        <p v-if="error" class="text-sm text-rose-400" data-testid="login-error">{{ error }}</p>
        <UButton
          block
          size="lg"
          color="primary"
          type="submit"
          :loading="busy"
          data-testid="login-submit"
        >
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

      <!-- Paste-a-token sign-in: your own PAT on a hosted node; on local mode the token this
           deployment will operate with (see `remotePatProviders`). -->
      <template v-if="remotePatProviders.length > 0 && mode !== 'forgot'">
        <div
          v-if="
            auth.providers.github ||
            auth.providers.google ||
            auth.providers.password ||
            hasConfiguredPat
          "
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
              @click="
                () => {
                  remotePatProvider = p
                }
              "
            >
              {{ PROVIDER_LABELS[p] }}
            </UButton>
          </div>
          <SecretInput
            v-model="remotePatToken"
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
          <!-- Local mode only: say what else the token is for BEFORE it is handed over, since it
               becomes the credential every agent step on this machine clones and pushes with. -->
          <p v-if="isLocalMode" class="px-1 text-xs text-slate-400">
            {{ t('auth.localMode.tokenBecomesCredential') }}
          </p>
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
