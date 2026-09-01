<script setup lang="ts">
// The MERGED catalog an Architect is actually handed for this board — the deployment's
// code-registered `builtin` services ⊕ account ⊕ workspace, the later tier winning by id
// (backend/docs/adr/0031-foundational-services.md). Workspace scope only: a board is what runs
// agents, so this is the only place the whole merge is realised.
//
// This view is where the two board-level decisions live, and they are deliberately different
// actions rather than one "remove":
//   - SUPPRESS an inherited account service — the board opts out, nothing is destroyed, and it is
//     reversible with restore. The account keeps the service for every other board.
//   - a service the board REGISTERED itself is edited or deleted in the other tab; suppressing it
//     would be an obscure spelling of delete, and the backend refuses it as such.
//
// A contract body is fetched only when a human expands one, through the SAME lazy read a consumer
// dispatch makes — so what is inspected here is what an agent would be given, and merely opening
// the catalog transfers no documents.
import { computed, reactive, ref } from 'vue'
import type { ApiContractFormat, FoundationalServiceTier } from '~/types/domain'
import { useFoundationalServicesStore } from '~/stores/foundationalServices'
import FoundationalContractSummary from '~/components/foundational/FoundationalContractSummary.vue'

const catalog = useFoundationalServicesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()

// Exhaustive maps of literal `t(...)` keys, so a new tier/format fails the typed-key guard.
const tierLabel = computed<Record<FoundationalServiceTier, string>>(() => ({
  builtin: t('foundational.tier.builtin'),
  account: t('foundational.tier.account'),
  workspace: t('foundational.tier.workspace'),
}))
const formatLabel = computed<Record<ApiContractFormat, string>>(() => ({
  openapi: t('foundational.format.openapi'),
  'toad-contract': t('foundational.format.toadContract'),
  'lokalise-api-contract': t('foundational.format.lokaliseApiContract'),
  asyncapi: t('foundational.format.asyncapi'),
  graphql: t('foundational.format.graphql'),
  grpc: t('foundational.format.grpc'),
}))
// `as const` keeps the literal colour names assignable to UBadge's `color` union.
const tierColor = {
  builtin: 'neutral',
  account: 'info',
  workspace: 'primary',
} as const satisfies Record<FoundationalServiceTier, string>

const busyRows = reactive(new Set<string>())
const rowBusy = (key: string) => busyRows.has(key)
async function withRow(key: string, fn: () => Promise<void>) {
  if (busyRows.has(key)) return
  busyRows.add(key)
  try {
    await fn()
  } finally {
    busyRows.delete(key)
  }
}

/** Service ids whose contract documents the user has expanded. */
const expanded = ref<string[]>([])

async function toggleContracts(serviceId: string) {
  if (expanded.value.includes(serviceId)) {
    expanded.value = expanded.value.filter((id) => id !== serviceId)
    return
  }
  await withRow(`docs:${serviceId}`, async () => {
    try {
      await catalog.contractsFor(serviceId)
      expanded.value = [...expanded.value, serviceId]
    } catch (e) {
      present(e, 'foundational.toast.contractsFailed')
    }
  })
}

async function suppress(serviceId: string) {
  await withRow(`suppress:${serviceId}`, async () => {
    try {
      await catalog.suppress(serviceId)
      toast.add({ title: t('foundational.toast.suppressed'), icon: 'i-lucide-eye-off' })
    } catch (e) {
      present(e, 'foundational.toast.suppressFailed')
    }
  })
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="foundational-catalog">
    <p class="text-xs text-slate-500">{{ t('foundational.catalog.intro') }}</p>

    <div
      v-for="s in catalog.resolved"
      :key="s.id"
      class="rounded-md border border-slate-800 bg-slate-900/60 p-3"
    >
      <div class="flex items-start gap-2">
        <UIcon name="i-lucide-boxes" class="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-slate-100">
            {{ s.name }}
            <code class="ms-1 text-[11px] text-slate-500">{{ s.id }}</code>
          </p>
          <p class="text-xs text-slate-400">{{ s.summary }}</p>
          <div v-if="s.capabilities.length" class="mt-1 flex flex-wrap gap-1">
            <UBadge v-for="c in s.capabilities" :key="c" size="xs" variant="subtle" color="neutral">
              {{ c }}
            </UBadge>
          </div>
          <FoundationalContractSummary :contracts="s.contracts" :format-label="formatLabel" />

          <div class="mt-2 flex items-center gap-2">
            <UButton
              v-if="s.contracts.length"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`docs:${s.id}`)"
              @click="toggleContracts(s.id)"
            >
              {{
                expanded.includes(s.id)
                  ? t('foundational.catalog.hideDocuments')
                  : t('foundational.catalog.showDocuments')
              }}
            </UButton>
          </div>
          <!-- The lazy read, rendered verbatim: this is the text a consumer step receives. -->
          <div v-if="expanded.includes(s.id)" class="mt-2 flex flex-col gap-2">
            <div
              v-for="doc in catalog.contractBodies[s.id] ?? []"
              :key="doc.contractId"
              class="rounded-md border border-slate-800 bg-slate-950/60 p-2"
            >
              <p class="mb-1 text-[11px] text-slate-400">
                {{ doc.title }}
                <span v-if="doc.path" class="ms-1 font-mono text-slate-600">{{ doc.path }}</span>
              </p>
              <pre class="max-h-64 overflow-auto text-[11px] text-slate-300">{{ doc.body }}</pre>
            </div>
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <UBadge size="xs" :color="tierColor[s.tier]" variant="subtle">
            {{ tierLabel[s.tier] }}
          </UBadge>
          <!-- Only an INHERITED entry can be suppressed — an account service or one the
               deployment registered in code; the board's own row is managed in the registry tab,
               where deleting it is the honest action. -->
          <UButton
            v-if="s.tier !== 'workspace'"
            icon="i-lucide-eye-off"
            size="xs"
            variant="ghost"
            :loading="rowBusy(`suppress:${s.id}`)"
            :title="t('foundational.catalog.suppress')"
            :data-testid="`foundational-suppress-${s.id}`"
            @click="suppress(s.id)"
          />
        </div>
      </div>
    </div>

    <p v-if="!catalog.resolved.length" class="text-sm text-slate-500">
      {{ t('foundational.catalog.empty') }}
    </p>
  </div>
</template>
