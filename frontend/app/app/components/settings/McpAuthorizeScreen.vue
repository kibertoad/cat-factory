<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PUBLIC_API_SCOPES, type PublicApiScope } from '@cat-factory/contracts'

// The consent screen an MCP host's authorization request lands on
// (`/mcp-authorize?request=…`), reached by a redirect from `GET /oauth/authorize`.
//
// A page in the APP rather than a screen the backend renders, and that is the security shape of
// this flow: the authorization endpoint is a top-level navigation a third party triggers, carrying
// no bearer token, so a screen served there could never say WHO is approving. Here the session is
// the app's own, and the two calls this page makes are ordinary gated API where the board choice
// and its `secrets.manage` check actually run.
//
// Not a public route: an expired session renders the login screen on this same URL, and once the
// person signs in the query string is still here and the flow continues. That is correct rather
// than a gap, and it is also how an SSO deployment gets its identity provider into a flow that
// otherwise has no idea who anyone is.

const api = useApi()
const { t } = useI18n()

type Screen = 'loading' | 'deciding' | 'submitting' | 'failed'

const screen = ref<Screen>('loading')
const detail = ref<string | null>(null)
const clientName = ref('')
const redirectOrigin = ref('')
const workspaces = ref<{ label: string; value: string }[]>([])
const workspaceId = ref<string | undefined>(undefined)
const scope = ref<PublicApiScope>('write')

const sealedRequest = computed(() =>
  typeof window === 'undefined'
    ? ''
    : (new URLSearchParams(window.location.search).get('request') ?? ''),
)

/**
 * The ladder, as choices. Every rung is offered rather than a curated subset: the rungs are what
 * the surface itself enforces, and hiding one would leave a host that genuinely needs it unable to
 * be granted it from the screen built for granting.
 */
const scopeItems = computed(() =>
  PUBLIC_API_SCOPES.map((value) => ({
    value,
    label: t(`mcpAuthorize.scope.${value}.label`),
    description: t(`mcpAuthorize.scope.${value}.description`),
  })),
)

onMounted(async () => {
  if (!sealedRequest.value) {
    screen.value = 'failed'
    detail.value = t('mcpAuthorize.error.noRequest')
    return
  }
  try {
    const [request, boards] = await Promise.all([
      api.describeMcpAuthorization(sealedRequest.value),
      api.listWorkspaces(),
    ])
    clientName.value = request.clientName
    redirectOrigin.value = request.redirectOrigin
    if (request.requestedScope) scope.value = request.requestedScope
    workspaces.value = boards.map((board) => ({ label: board.name, value: board.id }))
    workspaceId.value = workspaces.value[0]?.value
    screen.value = 'deciding'
  } catch (e) {
    screen.value = 'failed'
    detail.value = messageOf(e) ?? t('mcpAuthorize.error.expired')
  }
})

async function decide(decision: 'approve' | 'deny') {
  if (decision === 'approve' && !workspaceId.value) return
  screen.value = 'submitting'
  try {
    const result = await api.decideMcpAuthorization(
      decision === 'approve'
        ? {
            decision,
            request: sealedRequest.value,
            workspaceId: workspaceId.value as string,
            scope: scope.value,
          }
        : { decision, request: sealedRequest.value },
    )
    // A full navigation, never a router push: the destination is the HOST's own callback, which is
    // waiting for a browser to arrive at it with the code on the query string.
    if (typeof window !== 'undefined') window.location.assign(result.redirectTo)
  } catch (e) {
    screen.value = 'failed'
    detail.value = messageOf(e) ?? t('mcpAuthorize.error.failed')
  }
}

function messageOf(error: unknown): string | null {
  return (error as { data?: { error?: { message?: string } } })?.data?.error?.message ?? null
}

function backToApp() {
  if (typeof window !== 'undefined') window.location.assign('/')
}
</script>

<template>
  <div
    class="flex min-h-screen w-screen items-center justify-center bg-slate-950 p-4 text-slate-100"
    data-testid="mcp-authorize"
  >
    <div
      class="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <template v-if="screen === 'loading'">
        <UIcon name="i-lucide-loader" class="mx-auto h-10 w-10 animate-spin text-indigo-400" />
      </template>

      <template v-else-if="screen === 'failed'">
        <UIcon name="i-lucide-alert-triangle" class="mx-auto mb-3 h-10 w-10 text-red-400" />
        <h1
          class="mb-1 text-center text-lg font-semibold text-white"
          data-testid="mcp-authorize-failed"
        >
          {{ t('mcpAuthorize.error.title') }}
        </h1>
        <p class="mb-6 text-center text-sm break-words text-slate-400">{{ detail }}</p>
        <UButton block color="neutral" variant="subtle" @click="backToApp">
          {{ t('mcpAuthorize.back') }}
        </UButton>
      </template>

      <template v-else>
        <UIcon name="i-lucide-plug-zap" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-center text-lg font-semibold text-white">
          {{ t('mcpAuthorize.title', { client: clientName }) }}
        </h1>
        <!-- The origin is the one fact here an attacker cannot choose: it was matched against what
             the client registered before this screen was ever reached. The name beside it is a
             stranger's own words, so the copy presents it as a claim rather than as identity. -->
        <p class="mb-6 text-center text-sm text-slate-400">
          {{ t('mcpAuthorize.subtitle', { origin: redirectOrigin }) }}
        </p>

        <div v-if="!workspaces.length" class="mb-6 text-center text-sm text-amber-300">
          {{ t('mcpAuthorize.noWorkspaces') }}
        </div>

        <template v-else>
          <UFormField :label="t('mcpAuthorize.workspace.label')" class="mb-4">
            <USelect
              v-model="workspaceId"
              :items="workspaces"
              value-key="value"
              class="w-full"
              data-testid="mcp-authorize-workspace"
            />
          </UFormField>

          <UFormField
            :label="t('mcpAuthorize.scopeLabel')"
            :description="t('mcpAuthorize.scopeHint')"
            class="mb-6"
          >
            <URadioGroup
              v-model="scope"
              :items="scopeItems"
              value-key="value"
              data-testid="mcp-authorize-scope"
            />
          </UFormField>
        </template>

        <div class="flex gap-2">
          <UButton
            block
            color="neutral"
            variant="subtle"
            :disabled="screen === 'submitting'"
            @click="decide('deny')"
          >
            {{ t('mcpAuthorize.deny') }}
          </UButton>
          <UButton
            block
            color="primary"
            :loading="screen === 'submitting'"
            :disabled="!workspaceId"
            data-testid="mcp-authorize-approve"
            @click="decide('approve')"
          >
            {{ t('mcpAuthorize.approve') }}
          </UButton>
        </div>

        <p class="mt-4 text-center text-xs text-slate-500">{{ t('mcpAuthorize.revokeHint') }}</p>
      </template>
    </div>
  </div>
</template>
