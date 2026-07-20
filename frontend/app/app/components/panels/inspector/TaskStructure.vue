<script setup lang="ts">
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import FragmentSelector from '~/components/fragments/FragmentSelector.vue'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const { t } = useI18n()

// ---- best-practice prompt fragments ----------------------------------------
// The task's OWN selection (seeded from its service at creation, then editable per task). The
// shared <FragmentSelector> renders the picker; a change persists via updateBlock.
const fragmentPool = computed(() => fragments.forBlockType(props.block.type))
function setFragments(ids: string[]) {
  board.updateBlock(props.block.id, { fragmentIds: ids })
}
</script>

<template>
  <InspectorSection :title="t('inspector.structure.title')" :hint="t('inspector.structure.hint')">
    <!-- module assignment -->
    <div>
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.structure.module') }}
      </div>
      <UInput
        v-model="block.moduleName"
        size="sm"
        class="w-full"
        :placeholder="t('inspector.structure.modulePlaceholder')"
        icon="i-lucide-package"
      />
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.moduleHint') }}
      </p>
    </div>

    <!-- best practices (prompt fragments) -->
    <div>
      <FragmentSelector
        :model-value="block.fragmentIds ?? []"
        :pool="fragmentPool"
        :label="t('inspector.structure.bestPractices')"
        :empty-text="t('inspector.structure.bestPracticesEmpty')"
        @update:model-value="setFragments"
      />
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.bestPracticesHint') }}
      </p>
    </div>
  </InspectorSection>
</template>
