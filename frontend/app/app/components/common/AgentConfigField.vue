<script setup lang="ts">
// One agent-contributed task config value (an `AgentConfigDescriptor`): option buttons for a
// `select`, an input for `text` and `number`. Shared by the add-task form and the task inspector
// so the two draw every descriptor type the same way. Where they differ is when a typed value
// leaves the field: the form keeps it locally and saves with the task (`commit: 'input'`), while
// the inspector saves to the block, one update per save (`commit: 'change'`, on blur or Enter).
import { AGENT_CONFIG_VALUE_MAX_LENGTH, type AgentConfigDescriptor } from '@cat-factory/contracts'

const props = withDefaults(
  defineProps<{
    descriptor: AgentConfigDescriptor
    value: string
    disabled?: boolean
    commit?: 'input' | 'change'
  }>(),
  { disabled: false, commit: 'input' },
)

const emit = defineEmits<{ update: [value: string] }>()

function onInput(value: string | number) {
  if (props.commit === 'input') emit('update', String(value))
}

function onChange(event: Event) {
  if (props.commit === 'change') emit('update', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div v-if="descriptor.type === 'select'" class="flex flex-wrap gap-1">
    <UButton
      v-for="opt in descriptor.options"
      :key="opt.value"
      :color="value === opt.value ? 'primary' : 'neutral'"
      :variant="value === opt.value ? 'soft' : 'ghost'"
      size="xs"
      :disabled="disabled"
      @click="emit('update', opt.value)"
    >
      {{ opt.label }}
    </UButton>
  </div>
  <!-- The cap is the stored value's limit, so a longer value cannot reach a save that fails. -->
  <UInput
    v-else
    :model-value="value"
    :type="descriptor.type === 'number' ? 'number' : 'text'"
    :maxlength="descriptor.type === 'text' ? AGENT_CONFIG_VALUE_MAX_LENGTH : undefined"
    :placeholder="descriptor.placeholder"
    :disabled="disabled"
    size="xs"
    class="w-full"
    :data-testid="`agent-config-${descriptor.id}`"
    @update:model-value="onInput"
    @change="onChange"
  />
</template>
