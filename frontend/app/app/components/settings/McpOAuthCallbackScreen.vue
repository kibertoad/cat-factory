<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Spinner from '~/components/common/Spinner.vue'
import { useCopyToClipboard } from '~/composables/useCopyToClipboard'
import { describeCallbackFailure, type CallbackFailure } from './McpOAuthCallbackScreen.logic'

// Where a vendor's authorization server sends the operator's browser back to after they approve a
// remote MCP tool server (`/mcp-oauth-callback?code=…&state=…`).
//
// A page in the APP rather than a route on the backend, which is the security shape of this flow
// rather than a routing preference: a redirect is a third-party navigation carrying no bearer
// token, so a backend receiver could never tell WHO was completing the grant. This page re-presents
// the two values over the authenticated API, where the session, the "same user who started it"
// binding and the `secrets.manage` re-check all actually run.
//
// It is NOT a public route (unlike the password reset beside it): an expired session renders the
// login screen on this same URL, and once the operator signs in the query string is still here and
// the grant completes. That is the correct behaviour, not a gap.

const api = useApi()
const { t } = useI18n()

const { copy } = useCopyToClipboard()

const state = ref<'working' | 'done' | 'failed'>('working')
const serverId = ref<string | null>(null)
// Inline rather than a toast: this page is the whole screen, and a toast over it would leave the
// card saying nothing about what went wrong.
const failure = ref<CallbackFailure | null>(null)
const showFailureDetail = ref(false)

function query(name: string): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

onMounted(async () => {
  // An authorization server that REFUSED reports it here rather than on the token endpoint, so the
  // operator's own "Deny" and a misconfigured client both arrive as this. Named rather than folded
  // into "no code": one is nothing to fix and the other is the client registration.
  const denied = query('error')
  if (denied) {
    state.value = 'failed'
    failure.value = { kind: 'text', text: query('error_description') || denied }
    return
  }
  const code = query('code')
  const sealed = query('state')
  if (!code || !sealed) {
    state.value = 'failed'
    failure.value = { kind: 'text', text: t('settings.toolServers.oauth.callback.missingParams') }
    return
  }
  try {
    const result = await api.completeToolServerOAuth({ code, state: sealed })
    serverId.value = result.serverId
    state.value = 'done'
  } catch (e) {
    state.value = 'failed'
    failure.value = describeCallbackFailure(e, (id) => t('errors.generic.requestId', { id }))
  }
})

/** The whole failure as one report, so the request id reaches a bug report intact. */
function copyReport(description: string, detail: string) {
  void copy(
    [t('settings.toolServers.oauth.callback.failedTitle'), description, detail]
      .filter((part) => part.length > 0)
      .join('\n'),
  )
}

function backToApp() {
  if (typeof window !== 'undefined') window.location.assign('/')
}
</script>

<template>
  <div
    class="flex h-screen w-screen items-center justify-center bg-app-950 text-app-100"
    data-testid="mcp-oauth-callback"
  >
    <div
      class="w-full max-w-sm rounded-xl border border-default bg-default/80 p-8 text-center backdrop-blur"
    >
      <template v-if="state === 'working'">
        <Spinner class="mx-auto mb-3 h-10 w-10 text-primary" />
        <h1 class="mb-1 text-lg font-semibold text-highlighted">
          {{ t('settings.toolServers.oauth.callback.working') }}
        </h1>
      </template>

      <template v-else-if="state === 'done'">
        <UIcon name="i-lucide-check-circle" class="mx-auto mb-3 h-10 w-10 text-app-success-400" />
        <h1
          class="mb-1 text-lg font-semibold text-highlighted"
          data-testid="mcp-oauth-callback-done"
        >
          {{ t('settings.toolServers.oauth.callback.done', { server: serverId }) }}
        </h1>
        <p class="mb-6 text-sm text-muted">
          {{ t('settings.toolServers.oauth.callback.doneHint') }}
        </p>
        <UButton block @click="backToApp">
          {{ t('settings.toolServers.oauth.callback.back') }}
        </UButton>
      </template>

      <template v-else>
        <UIcon name="i-lucide-alert-triangle" class="mx-auto mb-3 h-10 w-10 text-app-error-400" />
        <h1
          class="mb-1 text-lg font-semibold text-highlighted"
          data-testid="mcp-oauth-callback-failed"
        >
          {{ t('settings.toolServers.oauth.callback.failedTitle') }}
        </h1>
        <div v-if="failure?.kind === 'api'" class="mb-6 space-y-2">
          <p class="text-sm break-words text-muted" data-testid="mcp-oauth-callback-reason">
            {{ t(failure.descriptionKey) }}
          </p>
          <p v-if="failure.restartHint" class="text-sm text-muted">
            {{ t('settings.toolServers.oauth.callback.restartHint') }}
          </p>
          <div class="flex flex-wrap items-center justify-center gap-x-3">
            <UButton
              v-if="failure.detail && !showFailureDetail"
              color="neutral"
              variant="link"
              size="xs"
              class="p-0"
              data-testid="mcp-oauth-callback-detail"
              @click="showFailureDetail = true"
            >
              {{ t('errors.generic.showDetail') }}
            </UButton>
            <UButton
              color="neutral"
              variant="link"
              size="xs"
              class="p-0"
              icon="i-lucide-clipboard"
              data-testid="mcp-oauth-callback-copy"
              @click="copyReport(t(failure.descriptionKey), failure.detail)"
            >
              {{ t('common.copyDetails') }}
            </UButton>
          </div>
          <p v-if="showFailureDetail" class="font-mono text-3xs break-all text-dimmed select-text">
            {{ failure.detail }}
          </p>
        </div>
        <p v-else class="mb-6 text-sm break-words text-muted">{{ failure?.text }}</p>
        <UButton block color="neutral" variant="subtle" @click="backToApp">
          {{ t('settings.toolServers.oauth.callback.back') }}
        </UButton>
      </template>
    </div>
  </div>
</template>
