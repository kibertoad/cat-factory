<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  duplicateBindingEnvVars,
  resolveFrontendBindings,
  type FrontendBackendBinding,
  type FrontendConfig,
  type ResolvedFrontendBinding,
} from '@cat-factory/contracts'

// The resolution of a frontend frame's backend bindings — each env var → a bound service's live
// ephemeral URL, or WireMock. Two modes, same view:
//   - **Live** (frame inspector, `resolved` omitted): resolves against the workspace's CURRENT env
//     handles (fetched once via the environments store), so the operator sees how a run would
//     resolve RIGHT NOW. Feeds the SAME pure helpers the backend uses so it can't drift.
//   - **Projected** (`tester-ui` run/step detail, `resolved` provided): renders the FROZEN
//     start-time bindings the engine stamped on the run, so a finished run shows what it ACTUALLY
//     drove against — truthful even after the underlying envs are torn down (no live re-read).
// Also surfaces the duplicate-env-var misconfiguration in live mode (projected mode leaves that to
// the run-start note, which owns the frozen advisory).
const props = defineProps<{ config: FrontendConfig; resolved?: ResolvedFrontendBinding[] }>()

const environments = useEnvironmentsStore()
const board = useBoardStore()
const { t } = useI18n()

const projected = computed(() => props.resolved !== undefined)

// Live mode refreshes the env handles when this view opens so a just-provisioned service shows as
// live; a projected snapshot needs no live read.
onMounted(() => {
  if (!projected.value) void environments.load()
})

// The duplicate advisory is config-derived; in projected mode the run-start note owns it (frozen
// at start), so don't re-derive it here against a possibly-since-edited config.
const duplicates = computed(() => (projected.value ? [] : duplicateBindingEnvVars(props.config)))

// Each resolved binding + the display metadata a bare {envVar, serviceUrl} can't carry: whether
// a mocked upstream was a `mock` source or a `service` with no live env, and the bound service's
// title. Joined off the LAST config binding per envVar (matching `resolveFrontendBindings`'
// last-wins dedup), so the extra labels stay in step with the canonical resolution.
const rows = computed(() => {
  const resolved =
    props.resolved ??
    resolveFrontendBindings(props.config, environments.liveServiceEnvUrls(props.config))
  const lastByEnvVar = new Map<string, FrontendBackendBinding>()
  for (const b of props.config.backendBindings) {
    const key = b.envVar.trim()
    if (key) lastByEnvVar.set(key, b)
  }
  return resolved.map((r) => {
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
