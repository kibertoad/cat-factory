<script setup lang="ts">
import { computed } from 'vue'
import type { Block, ServiceConnection } from '~/types/domain'

// Service-frame (`type: 'service'`) connections: the other services this one USES
// (consumer→provider edges, stored on this frame — the consumer end). Each row picks a
// provider service frame and optionally describes the relationship (folded into agent
// prompts when the provider is involved in a task). The rows ARE the board's
// service→service links, and the source of a task's "involved services" choices.
// Persisted as serviceConnections on the block via the shared updateBlock PATCH.
// The read-only "Used by" list below is the reverse direction, computed from the
// OTHER frames' connections targeting this one.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const { t } = useI18n()

const connections = computed<ServiceConnection[]>(() => props.block.serviceConnections ?? [])

function save(next: ServiceConnection[]) {
  board.updateBlock(props.block.id, { serviceConnections: next })
}

// Provider candidates: every OTHER service frame on the board. A frame already used by
// another row is excluded per row (duplicates are rejected server-side too).
const serviceFrames = computed(() =>
  board.frames.filter((b) => b.type === 'service' && b.id !== props.block.id),
)

function targetItems(index: number) {
  const takenElsewhere = new Set(
    connections.value.filter((_, i) => i !== index).map((c) => c.serviceBlockId),
  )
  return serviceFrames.value
    .filter((f) => !takenElsewhere.has(f.id))
    .map((f) => ({ label: f.title || f.id, value: f.id }))
}

function replaceConnection(index: number, next: ServiceConnection) {
  save(connections.value.map((c, i) => (i === index ? next : c)))
}

function setTarget(index: number, serviceBlockId: string) {
  const c = connections.value[index]
  if (c) replaceConnection(index, { ...c, serviceBlockId })
}

function setDescription(index: number, value: string) {
  const c = connections.value[index]
  if (c) replaceConnection(index, { ...c, description: value.trim() || undefined })
}

// A new row starts on the first still-available provider; with none available the add
// button is disabled, so a placeholder row never round-trips an invalid PATCH.
const nextAvailable = computed(() => {
  const taken = new Set(connections.value.map((c) => c.serviceBlockId))
  return serviceFrames.value.find((f) => !taken.has(f.id))
})

function addConnection() {
  const target = nextAvailable.value
  if (target) save([...connections.value, { serviceBlockId: target.id }])
}

function removeConnection(index: number) {
  save(connections.value.filter((_, i) => i !== index))
}

// Reverse direction, read-only: the service frames whose own connections name this one.
const usedBy = computed(() =>
  board.frames.filter(
    (b) =>
      b.type === 'service' &&
      b.id !== props.block.id &&
      (b.serviceConnections ?? []).some((c) => c.serviceBlockId === props.block.id),
  ),
)
</script>

<template>
  <div class="space-y-2 border-t border-slate-800 pt-2" data-testid="service-connections">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.serviceConnections.title') }}
      </span>
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-plus"
        :disabled="!nextAvailable"
        data-testid="service-connection-add"
        @click="addConnection"
      />
    </div>
    <p class="text-[11px] leading-snug text-slate-500">
      {{ t('inspector.serviceConnections.hint') }}
    </p>

    <div v-if="connections.length" class="space-y-1.5">
      <div
        v-for="(c, i) in connections"
        :key="c.serviceBlockId"
        class="flex items-center gap-1"
        data-testid="service-connection-row"
      >
        <USelect
          :model-value="c.serviceBlockId"
          :items="targetItems(i)"
          size="xs"
          class="flex-1"
          data-testid="service-connection-target"
          @update:model-value="(v: string) => setTarget(i, v)"
        />
        <UInput
          :model-value="c.description ?? ''"
          size="xs"
          class="flex-1"
          maxlength="300"
          :placeholder="t('inspector.serviceConnections.descriptionPlaceholder')"
          data-testid="service-connection-description"
          @blur="(e: FocusEvent) => setDescription(i, (e.target as HTMLInputElement).value)"
          @keydown.enter="
            (e: KeyboardEvent) => setDescription(i, (e.target as HTMLInputElement).value)
          "
        />
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-x"
          :title="t('inspector.serviceConnections.remove')"
          data-testid="service-connection-remove"
          @click="removeConnection(i)"
        />
      </div>
    </div>
    <div v-else class="text-[11px] text-slate-500">
      {{ t('inspector.serviceConnections.empty') }}
    </div>

    <div v-if="usedBy.length" class="space-y-1" data-testid="service-connections-used-by">
      <span class="text-[11px] text-slate-400">{{ t('inspector.serviceConnections.usedBy') }}</span>
      <div class="flex flex-wrap gap-1">
        <UBadge v-for="f in usedBy" :key="f.id" size="sm" variant="soft" color="neutral">
          {{ f.title || f.id }}
        </UBadge>
      </div>
    </div>
  </div>
</template>
