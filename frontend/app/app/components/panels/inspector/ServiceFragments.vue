<script setup lang="ts">
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import FragmentSelector from '~/components/fragments/FragmentSelector.vue'

// Service-level best-practice fragments (frame blocks). These are the programming
// standards/guidelines for the whole service: they SEED a new task's own selection at creation,
// and at run time their bodies fold into the frame's own `code-aware` runs. Drawn from the
// board's merged fragment catalog (built-in ∪ registered ∪ account ∪ workspace). `defaultOpen`
// expands the section on surfaces that embed this as the primary content (the add-service
// modal); the inspector leaves it collapsed. The shared <FragmentSelector> renders the picker.
const props = defineProps<{ block: Block; defaultOpen?: boolean }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const { t } = useI18n()

function setFragments(ids: string[]) {
  board.updateBlock(props.block.id, { serviceFragmentIds: ids })
}
</script>

<template>
  <InspectorSection
    :title="t('inspector.fragments.serviceTitle')"
    :hint="t('inspector.fragments.serviceHint')"
    :count="(block.serviceFragmentIds ?? []).length"
    :default-open="props.defaultOpen"
  >
    <FragmentSelector
      :model-value="block.serviceFragmentIds ?? []"
      :pool="fragments.fragments"
      :empty-text="t('inspector.fragments.serviceEmpty')"
      @update:model-value="setFragments"
    />
  </InspectorSection>
</template>
