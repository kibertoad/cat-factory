<script setup lang="ts">
import { onMounted, ref } from 'vue'

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

const state = ref<'working' | 'done' | 'failed'>('working')
const detail = ref<string | null>(null)
const serverId = ref<string | null>(null)

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
    detail.value = query('error_description') || denied
    return
  }
  const code = query('code')
  const sealed = query('state')
  if (!code || !sealed) {
    state.value = 'failed'
    detail.value = t('settings.toolServers.oauth.callback.missingParams')
    return
  }
  try {
    const result = await api.completeToolServerOAuth({ code, state: sealed })
    serverId.value = result.serverId
    state.value = 'done'
  } catch (e) {
    state.value = 'failed'
    detail.value =
      (e as { data?: { error?: { message?: string } } })?.data?.error?.message ??
      t('settings.toolServers.oauth.callback.failed')
  }
})

function backToApp() {
  if (typeof window !== 'undefined') window.location.assign('/')
}
</script>

<template>
  <div
    class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100"
    data-testid="mcp-oauth-callback"
  >
    <div
      class="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-8 text-center backdrop-blur"
    >
      <template v-if="state === 'working'">
        <UIcon name="i-lucide-loader" class="mx-auto mb-3 h-10 w-10 animate-spin text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">
          {{ t('settings.toolServers.oauth.callback.working') }}
        </h1>
      </template>

      <template v-else-if="state === 'done'">
        <UIcon name="i-lucide-check-circle" class="mx-auto mb-3 h-10 w-10 text-emerald-400" />
        <h1 class="mb-1 text-lg font-semibold text-white" data-testid="mcp-oauth-callback-done">
          {{ t('settings.toolServers.oauth.callback.done', { server: serverId }) }}
        </h1>
        <p class="mb-6 text-sm text-slate-400">
          {{ t('settings.toolServers.oauth.callback.doneHint') }}
        </p>
        <UButton block color="primary" @click="backToApp">
          {{ t('settings.toolServers.oauth.callback.back') }}
        </UButton>
      </template>

      <template v-else>
        <UIcon name="i-lucide-alert-triangle" class="mx-auto mb-3 h-10 w-10 text-red-400" />
        <h1 class="mb-1 text-lg font-semibold text-white" data-testid="mcp-oauth-callback-failed">
          {{ t('settings.toolServers.oauth.callback.failedTitle') }}
        </h1>
        <p class="mb-6 text-sm break-words text-slate-400">{{ detail }}</p>
        <UButton block color="neutral" variant="subtle" @click="backToApp">
          {{ t('settings.toolServers.oauth.callback.back') }}
        </UButton>
      </template>
    </div>
  </div>
</template>
