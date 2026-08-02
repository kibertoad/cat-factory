<script setup lang="ts">
// One service's contract MANIFEST — id, format, size and the indexed operation names, never a
// document body (backend/docs/adr/0031-foundational-services.md). This is exactly what an Architect's
// catalog carries, so rendering the same fields here is what makes the surface answer "what will
// the design actually see?".
//
// `omittedOperations` is rendered rather than dropped: the operation list is CAPPED (and, for a
// contract module, read by a best-effort static extractor), and a reader who assumed it complete
// would conclude the missing endpoints do not exist.
//
// An EMPTY list is likewise never left to speak for itself: `operationsAreIndexable` tells apart a
// format this platform does not read from an interface that genuinely declares nothing, and the
// two need opposite reactions from whoever is looking.
import { operationsAreIndexable } from '@cat-factory/contracts'
import type { ApiContractFormat, ApiContractSummary } from '~/types/domain'

defineProps<{
  contracts: ApiContractSummary[]
  /** Exhaustive format → translated label map, owned by the caller so the keys stay literal. */
  formatLabel: Record<ApiContractFormat, string>
}>()

const { t, n } = useI18n()
</script>

<template>
  <div v-if="contracts.length" class="mt-1 flex flex-col gap-1">
    <div v-for="c in contracts" :key="c.contractId" class="text-[11px] text-slate-500">
      <span class="text-slate-400">{{ c.title }}</span>
      <span class="ms-1">({{ formatLabel[c.format] }}, {{ n(c.size) }})</span>
      <span v-if="c.operations.length" class="ms-1 font-mono text-slate-500">
        {{ c.operations.join(' · ') }}
      </span>
      <span v-else-if="!operationsAreIndexable(c.format)" class="ms-1 text-slate-600">
        {{ t('foundational.contracts.notIndexed') }}
      </span>
      <span v-else-if="!c.omittedOperations" class="ms-1 text-slate-600">
        {{ t('foundational.contracts.noOperations') }}
      </span>
      <span v-if="c.omittedOperations > 0" class="ms-1 text-amber-500/80">
        {{ t('foundational.contracts.omitted', { count: c.omittedOperations }) }}
      </span>
    </div>
  </div>
  <p v-else class="mt-1 text-[11px] text-amber-500/80">
    {{ t('foundational.contracts.none') }}
  </p>
</template>
