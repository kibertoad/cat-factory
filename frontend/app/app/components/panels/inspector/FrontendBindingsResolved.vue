<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  duplicateBindingEnvVars,
  resolveFrontendBindings,
  type FrontendBackendBinding,
  type FrontendConfig,
} from '@cat-factory/contracts'

// The LIVE resolution of a frontend frame's backend bindings — the SPA mirror of what a UI-test
// run resolves at start: each env var → a bound service's live ephemeral URL, or WireMock. Shared
// by the frame inspector (current state) and a `tester-ui` step's run detail (what the run drives
// against). Reads the workspace's env handles once via the environments store and feeds the SAME
// pure helpers the backend uses (`resolveFrontendBindings` / `indexLiveServiceEnvUrls`), so the
// view can't drift from the run. Also surfaces the duplicate-env-var misconfiguration.
const props = defineProps<{ config: FrontendConfig }>()

const environments = useEnvironmentsStore()
const board = useBoardStore()
const { t } = useI18n()

// Refresh the env handles when this view opens so a just-provisioned service shows as live.
onMounted(() => void environments.load())

const duplicates = computed(() => duplicateBindingEnvVars(props.config))

// Each resolved binding + the display metadata a bare {envVar, serviceUrl} can't carry: whether
// a mocked upstream was a `mock` source or a `service` with no live env, and the bound service's
// title. Joined off the LAST config binding per envVar (matching `resolveFrontendBindings`'
// last-wins dedup), so the extra labels stay in step with the canonical resolution.
const rows = computed(() => {
  const live = environments.liveServiceEnvUrls(props.config)
  const lastByEnvVar = new Map<string, FrontendBackendBinding>()
  for (const b of props.config.backendBindings) {
    const key = b.envVar.trim()
    if (key) lastByEnvVar.set(key, b)
  }
  return resolveFrontendBindings(props.config, live).map((r) => {
    const source = lastByEnvVar.get(r.envVar)?.source
    const serviceFrameId = source?.kind === 'service' ? source.serviceBlockId : undefined
    return {
      envVar: r.envVar,
      serviceUrl: r.serviceUrl,
      kind: r.serviceUrl ? 'live' : source?.kind === 'service' ? 'service-offline' : 'mock',
      serviceTitle: serviceFrameId
        ? (board.getBlock(serviceFrameId)?.title ?? serviceFrameId)
        : undefined,
    } as const
  })
})
</script>

<template>
  <div v-if="rows.length || duplicates.length" class="space-y-1.5" data-testid="frontend-resolved">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('inspector.frontendConfig.resolved.title') }}
    </div>

    <p
      v-if="duplicates.length"
      class="text-[11px] leading-snug text-amber-300/80"
      data-testid="frontend-resolved-duplicates"
    >
      {{ t('inspector.frontendConfig.resolved.duplicateWarning', { vars: duplicates.join(', ') }) }}
    </p>

    <ul v-if="rows.length" class="space-y-0.5">
      <li
        v-for="row in rows"
        :key="row.envVar"
        class="flex items-baseline gap-1.5 text-[11px] leading-snug"
        data-testid="frontend-resolved-row"
      >
        <span
          class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
          :class="{
            'bg-emerald-400': row.kind === 'live',
            'bg-amber-400': row.kind === 'service-offline',
            'bg-slate-500': row.kind === 'mock',
          }"
        />
        <span class="font-mono text-slate-300">{{ row.envVar }}</span>
        <span class="text-slate-600">→</span>
        <template v-if="row.kind === 'live'">
          <span class="truncate font-mono text-emerald-300/90">{{ row.serviceUrl }}</span>
          <span v-if="row.serviceTitle" class="text-slate-500">({{ row.serviceTitle }})</span>
        </template>
        <span v-else-if="row.kind === 'service-offline'" class="text-amber-300/80">
          {{ t('inspector.frontendConfig.resolved.serviceOffline', { service: row.serviceTitle }) }}
        </span>
        <span v-else class="text-slate-500">
          {{ t('inspector.frontendConfig.resolved.mock') }}
        </span>
      </li>
    </ul>
  </div>
</template>
