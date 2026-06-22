<script setup lang="ts">
import { computed } from 'vue'
import type { Block, CloudProvider, InstanceSize } from '~/types/domain'

// Service-level (frame) configuration: where the Tester's local-mode infra comes
// from (a docker-compose path, or an explicit "no infra dependencies" toggle — a
// Tester pipeline can't start until one is set), plus the cloud provider + instance
// size the service's container jobs run on. Autodiscovery suggests a compose path
// when the service is added; it can be set/changed here later.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const accounts = useAccountsStore()

const composePath = computed(() => props.block.testComposePath ?? '')
const noInfra = computed(() => props.block.noInfraDependencies === true)

// A service with no explicit provider inherits the active account's default (else the
// built-in `cloudflare`); show that as the selected chip so the inherited value is visible.
const effectiveProvider = computed<CloudProvider>(
  () => props.block.cloudProvider ?? accounts.activeAccount?.defaultCloudProvider ?? 'cloudflare',
)

function setComposePath(value: string) {
  board.updateBlock(props.block.id, { testComposePath: value.trim() })
}
function toggleNoInfra(value: boolean) {
  board.updateBlock(props.block.id, { noInfraDependencies: value })
}

const PROVIDERS: { value: CloudProvider; label: string }[] = [
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'docker', label: 'Docker (local)' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'GCP' },
  { value: 'azure', label: 'Azure' },
  { value: 'custom', label: 'Custom' },
]
const SIZES: { value: InstanceSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'XLarge' },
]

function setProvider(value: CloudProvider) {
  board.updateBlock(props.block.id, { cloudProvider: value })
}
function setSize(value: InstanceSize) {
  board.updateBlock(props.block.id, { instanceSize: value })
}

const missingInfra = computed(() => !noInfra.value && composePath.value.trim() === '')
</script>

<template>
  <div class="space-y-3">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      Test infrastructure
    </div>

    <div class="space-y-1">
      <label class="text-[11px] text-slate-400">docker-compose path</label>
      <UInput
        :model-value="composePath"
        size="xs"
        placeholder="docker-compose.yml"
        :disabled="noInfra"
        @blur="(e: FocusEvent) => setComposePath((e.target as HTMLInputElement).value)"
        @keydown.enter="(e: KeyboardEvent) => setComposePath((e.target as HTMLInputElement).value)"
      />
      <p class="text-[11px] leading-snug text-slate-500">
        Used by the Tester to stand up the service's dependencies locally.
      </p>
    </div>

    <label class="flex items-center gap-2 text-[11px] text-slate-400">
      <UCheckbox
        :model-value="noInfra"
        @update:model-value="(v: boolean | 'indeterminate') => toggleNoInfra(v === true)"
      />
      No infra dependencies (the Tester spins nothing up)
    </label>

    <p v-if="missingInfra" class="text-[11px] leading-snug text-amber-500">
      Set a docker-compose path or enable “no infra dependencies”, otherwise a pipeline with a
      Tester won't start.
    </p>

    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">Cloud provider</span>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="p in PROVIDERS"
          :key="p.value"
          :color="effectiveProvider === p.value ? 'primary' : 'neutral'"
          :variant="effectiveProvider === p.value ? 'soft' : 'ghost'"
          size="xs"
          @click="setProvider(p.value)"
        >
          {{ p.label }}
        </UButton>
      </div>
    </div>

    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">Instance size</span>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="s in SIZES"
          :key="s.value"
          :color="(block.instanceSize ?? 'medium') === s.value ? 'primary' : 'neutral'"
          :variant="(block.instanceSize ?? 'medium') === s.value ? 'soft' : 'ghost'"
          size="xs"
          @click="setSize(s.value)"
        >
          {{ s.label }}
        </UButton>
      </div>
    </div>
  </div>
</template>
