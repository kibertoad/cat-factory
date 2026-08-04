<script setup lang="ts">
// Tool servers (MCP) — the deployment's registered servers, and a Test button that speaks the
// protocol to one.
//
// It sits ABOVE the credential checklist in the same tab, because it is what the credentials on that
// list are FOR: the checklist answers "which keys does this deployment want", and this answers "and
// does the server they authenticate actually work". Both are `secrets.manage`-only, which is why the
// tab is hidden rather than disabled for anyone else.
//
// A row states four independent reasons a declared server may never reach a run — no kind declares
// it, no harness can serve its transport, its credentials do not resolve, the endpoint is dead — and
// each is rendered rather than implied. Before this panel the first two lived in a boot log and the
// deployment's own source, and the last two were only visible by starting a run and reading the
// agent's prompt.
import { computed, ref } from 'vue'
import type {
  ToolServerNotProbeableReason,
  ToolServerProbeStatus,
  ToolServerTransport,
  ToolServerView,
} from '~/types/toolServers'

const { t } = useI18n()
const store = useToolServersStore()
const { present } = usePipelineErrorToast()

// Which failure DETAILS are expanded, by server id. Collapsed by default: the translated status line
// is what an operator acts on, and the raw backend prose is a disclosure behind it (never the
// primary description) per the i18n rule.
const expanded = ref<Record<string, boolean>>({})

// Exhaustive Records over the wire vocabularies, so a member added in `@cat-factory/contracts` fails
// to compile here until it has translated copy. The sanctioned guard for an enum-keyed lookup the
// typed-message-key check cannot see.
const TRANSPORT_LABELS = computed<Record<ToolServerTransport, string>>(() => ({
  stdio: t('settings.toolServers.transport.stdio'),
  http: t('settings.toolServers.transport.http'),
}))
const STATUS_LABELS = computed<Record<ToolServerProbeStatus, string>>(() => ({
  ok: t('settings.toolServers.status.ok'),
  credentials_missing: t('settings.toolServers.status.credentialsMissing'),
  credential_refused: t('settings.toolServers.status.credentialRefused'),
  unreachable: t('settings.toolServers.status.unreachable'),
  http_error: t('settings.toolServers.status.httpError'),
  protocol_error: t('settings.toolServers.status.protocolError'),
  not_probeable: t('settings.toolServers.status.notProbeable'),
}))
const NOT_PROBEABLE_LABELS = computed<Record<ToolServerNotProbeableReason, string>>(() => ({
  stdio_transport: t('settings.toolServers.notProbeable.stdio'),
  container_local_url: t('settings.toolServers.notProbeable.containerLocal'),
  url_not_allowed: t('settings.toolServers.notProbeable.urlNotAllowed'),
}))

const servers = computed<ToolServerView[]>(() => store.view?.servers ?? [])

function resultFor(id: string) {
  return store.results[id]
}

/** Success is the only green; every other verdict names something for the operator to fix. */
function statusColor(status: ToolServerProbeStatus): 'success' | 'warning' | 'error' {
  if (status === 'ok') return 'success'
  return status === 'not_probeable' ? 'warning' : 'error'
}

async function runProbe(id: string) {
  try {
    await store.probe(id)
  } catch (e) {
    // A THROWN failure is not a verdict — a 404 for a server the deployment has since dropped, or a
    // transient 5xx. Presented through the shared status-class funnel rather than stored as a
    // result, so the row does not claim the probe answered.
    present(e, 'settings.toolServers.toast.probeFailed')
  }
}
</script>

<template>
  <section v-if="servers.length" class="space-y-3" data-testid="tool-servers-section">
    <div>
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.toolServers.heading') }}
      </h3>
      <p class="text-xs text-slate-400">{{ t('settings.toolServers.intro') }}</p>
    </div>

    <article
      v-for="server in servers"
      :key="server.id"
      class="space-y-2 rounded-lg border border-slate-700 p-3"
      :data-testid="`tool-server-${server.id}`"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-slate-200">{{ server.label }}</span>
        <UBadge color="neutral" variant="soft" size="sm">
          {{ TRANSPORT_LABELS[server.transport] }}
        </UBadge>
        <code class="font-mono text-[11px] text-slate-500">{{ server.id }}</code>
      </div>

      <p class="truncate font-mono text-[11px] text-slate-500" :title="server.target">
        {{ server.target }}
      </p>
      <p v-if="server.guidance" class="text-xs text-slate-400">{{ server.guidance }}</p>

      <!-- Which agents get it. An EMPTY list is a registration attached to nothing: it never reaches
           a dispatch, so the credentials it asks for are keys an operator fills in for no run. Said
           out loud, because no other surface in the platform can see that state. -->
      <p v-if="server.declaredBy.length" class="text-[11px] text-slate-400">
        {{ t('settings.toolServers.declaredBy', { kinds: server.declaredBy.join(', ') }) }}
      </p>
      <p v-else class="text-[11px] text-amber-400" :data-testid="`tool-server-orphan-${server.id}`">
        {{ t('settings.toolServers.declaredByNone') }}
      </p>

      <!-- Which harnesses could serve it. EMPTY means the declaration can never run anywhere (an
           `http` server narrowed to Codex, whose MCP client is stdio-only): it is never dropped FOR
           A REASON on any run, so no prompt and no log line ever mentions it. -->
      <p v-if="server.servableHarnesses.length" class="text-[11px] text-slate-400">
        {{
          t('settings.toolServers.servableHarnesses', {
            harnesses: server.servableHarnesses.join(', '),
          })
        }}
      </p>
      <p v-else class="text-[11px] text-amber-400">
        {{ t('settings.toolServers.servableHarnessesNone') }}
      </p>

      <p v-if="server.allowedTools?.length" class="text-[11px] text-slate-400">
        {{ t('settings.toolServers.allowedTools', { tools: server.allowedTools.join(', ') }) }}
      </p>
      <p v-if="server.credentials.length" class="text-[11px] text-slate-400">
        {{
          t('settings.toolServers.credentials', {
            keys: server.credentials.map((c) => c.key).join(', '),
          })
        }}
      </p>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <UButton
          v-if="server.probeable"
          size="xs"
          variant="subtle"
          icon="i-lucide-plug"
          :loading="store.probing === server.id"
          :disabled="store.probing !== null"
          :data-testid="`tool-server-test-${server.id}`"
          @click="runProbe(server.id)"
        >
          {{ t('settings.toolServers.test') }}
        </UButton>
        <!-- Not a disabled button: nothing the operator can do here makes it clickable, so the row
             states the reason instead. Each reason needs a different response — nothing to fix,
             verify it from a run, or change the declaration. -->
        <p
          v-else-if="server.notProbeableReason"
          class="text-[11px] text-slate-500"
          :data-testid="`tool-server-unprobeable-${server.id}`"
        >
          {{ NOT_PROBEABLE_LABELS[server.notProbeableReason] }}
        </p>
      </div>

      <div
        v-if="resultFor(server.id)"
        class="space-y-1 rounded-md border border-slate-800 bg-slate-900/40 p-2"
        :data-testid="`tool-server-result-${server.id}`"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            :color="statusColor(resultFor(server.id)!.status)"
            variant="soft"
            size="sm"
            :data-testid="`tool-server-status-${server.id}`"
          >
            {{ STATUS_LABELS[resultFor(server.id)!.status] }}
          </UBadge>
          <span v-if="resultFor(server.id)!.httpStatus" class="text-[11px] text-slate-400">
            {{ t('settings.toolServers.httpStatus', { status: resultFor(server.id)!.httpStatus }) }}
          </span>
        </div>

        <p v-if="resultFor(server.id)!.status === 'ok'" class="text-[11px] text-slate-300">
          {{
            t('settings.toolServers.okDetail', {
              name: resultFor(server.id)!.serverName || server.id,
              version: resultFor(server.id)!.serverVersion || '?',
              protocol: resultFor(server.id)!.protocolVersion ?? '?',
              count: resultFor(server.id)!.toolCount ?? 0,
            })
          }}
        </p>
        <!-- A count off a truncated read is a FLOOR, not a total, and the difference decides whether
             the allowedTools verdict below means anything. -->
        <p v-if="resultFor(server.id)!.toolsComplete === false" class="text-[11px] text-slate-500">
          {{ t('settings.toolServers.toolsIncomplete') }}
        </p>

        <!-- The reconciliation nothing else in the platform can do: a well-formed tool name that
             matches nothing narrows the CLI's allow-list to a dead pattern while the prompt keeps
             advertising the tool. Withheld entirely when the tool list was a prefix. -->
        <p
          v-if="resultFor(server.id)!.allowedTools?.unmatched?.length"
          class="text-[11px] text-amber-400"
          :data-testid="`tool-server-unmatched-${server.id}`"
        >
          {{
            t('settings.toolServers.unmatchedTools', {
              tools: resultFor(server.id)!.allowedTools!.unmatched.join(', '),
            })
          }}
        </p>
        <p
          v-else-if="resultFor(server.id)!.allowedTools?.checked === false"
          class="text-[11px] text-slate-500"
        >
          {{ t('settings.toolServers.allowedToolsUnchecked') }}
        </p>

        <p
          v-if="resultFor(server.id)!.unresolvedCredentials?.length"
          class="text-[11px] text-amber-400"
        >
          {{
            t('settings.toolServers.unresolvedCredentials', {
              keys: resultFor(server.id)!.unresolvedCredentials!.join(', '),
            })
          }}
        </p>
        <p v-if="resultFor(server.id)!.refusedCredentials?.length" class="text-[11px] text-red-400">
          {{
            t('settings.toolServers.refusedCredentials', {
              keys: resultFor(server.id)!.refusedCredentials!.join(', '),
            })
          }}
        </p>

        <!-- Raw backend prose is DETAIL behind a disclosure, never the primary description. It is
             already scrubbed through `redactSecrets` at the emit site. -->
        <template v-if="resultFor(server.id)!.error">
          <UButton
            size="xs"
            variant="link"
            class="px-0"
            :data-testid="`tool-server-details-${server.id}`"
            @click="expanded[server.id] = !expanded[server.id]"
          >
            {{
              expanded[server.id]
                ? t('settings.toolServers.hideDetails')
                : t('settings.toolServers.showDetails')
            }}
          </UButton>
          <pre
            v-if="expanded[server.id]"
            class="overflow-x-auto rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-400"
            >{{ resultFor(server.id)!.error }}</pre>
        </template>
      </div>
    </article>
  </section>
</template>
