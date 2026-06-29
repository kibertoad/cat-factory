<script setup lang="ts">
// A clear picker for WHERE work runs, replacing the old bare "delegate to runner pool"
// yes/no switch. It reads the deployment's available backends from the capability descriptor
// (`auth.infrastructure`) and presents the actual options for THIS deployment:
//   - execution axis → where agent containers run (local Docker host / Cloudflare Containers /
//     self-hosted runner pool);
//   - testEnv axis   → where the Tester's ephemeral environments run (in-container
//     docker-compose / an environment provider).
//
// The control is WRITABLE only in local mode, where the choice is a real per-workspace toggle
// (the `delegateAgentsToRunnerPool` / `delegateTestEnvToProvider` settings — this selector is a
// nicer face over those existing booleans, no new persistence). On the Worker/Node facades the
// active backend is determined by the deployment + whether a pool is registered (the Worker
// routes to a registered pool automatically, else Cloudflare Containers), so there it renders a
// read-only "Active: …" line instead of a control that wouldn't actually switch anything.
import { computed, ref } from 'vue'
import type { ExecutionBackendKind, TestEnvBackendKind } from '@cat-factory/contracts'

const props = defineProps<{ axis: 'execution' | 'testEnv' }>()

const { t } = useI18n()
const auth = useAuthStore()
const settings = useWorkspaceSettingsStore()
const providerConnections = useProviderConnectionsStore()
const toast = useToast()

type BackendKind = ExecutionBackendKind | TestEnvBackendKind

// Per-axis labels — static literal keys whose leaves mirror the contract enum values verbatim
// (so the typed-message-keys check stays live and a dynamic lookup is total).
const EXECUTION_LABELS: Record<ExecutionBackendKind, string> = {
  'local-docker': 'settings.infrastructure.executionBackend.local-docker',
  'cloudflare-containers': 'settings.infrastructure.executionBackend.cloudflare-containers',
  'runner-pool': 'settings.infrastructure.executionBackend.runner-pool',
}
const TEST_ENV_LABELS: Record<TestEnvBackendKind, string> = {
  'local-compose': 'settings.infrastructure.testEnvBackend.local-compose',
  'environment-provider': 'settings.infrastructure.testEnvBackend.environment-provider',
}

function labelFor(kind: BackendKind): string {
  const key =
    props.axis === 'execution'
      ? EXECUTION_LABELS[kind as ExecutionBackendKind]
      : TEST_ENV_LABELS[kind as TestEnvBackendKind]
  return t(key)
}

// Normalise to the union element type so array ops (`includes`/`find`) don't collapse to
// `never` across the execution/testEnv discriminated union.
const cap = computed<{ available: BackendKind[]; active: BackendKind } | null>(() => {
  const c = auth.infrastructure?.[props.axis]
  return c ? { available: c.available as BackendKind[], active: c.active as BackendKind } : null
})
const isLocal = computed(() => auth.localMode?.enabled === true)

// The backend reached by "delegating" away from the on-machine default, plus the provider
// connection that must exist for it to work.
const delegatedKind = computed<BackendKind>(() =>
  props.axis === 'execution' ? 'runner-pool' : 'environment-provider',
)
const connectionKind = computed<'runner-pool' | 'environment'>(() =>
  props.axis === 'execution' ? 'runner-pool' : 'environment',
)
const delegatedRegistered = computed(
  () => !!providerConnections.connectionFor(connectionKind.value),
)

// The on-machine / built-in default (the available option that isn't the delegated one).
const localKind = computed<BackendKind>(
  () =>
    cap.value?.available.find((k) => k !== delegatedKind.value) ??
    cap.value?.active ??
    'local-docker',
)

// The delegation flag is a genuine per-workspace toggle ONLY in local mode; elsewhere the
// active backend is registration/deployment-driven, so the control is read-only there.
const writable = computed(() => isLocal.value && (cap.value?.available.length ?? 0) > 1)

const delegated = computed(() =>
  props.axis === 'execution'
    ? settings.settings.delegateAgentsToRunnerPool
    : settings.settings.delegateTestEnvToProvider,
)

// The effective active backend. In local mode it follows the delegation flag; otherwise the
// delegated backend is active when its provider is registered (the Worker auto-routes to a
// registered pool), else the deployment default from the descriptor.
const activeKind = computed<BackendKind>(() => {
  if (!cap.value) return localKind.value
  if (writable.value) return delegated.value ? delegatedKind.value : localKind.value
  if (cap.value.available.includes(delegatedKind.value) && delegatedRegistered.value) {
    return delegatedKind.value
  }
  return cap.value.active
})

const saving = ref(false)

async function select(kind: BackendKind) {
  if (kind === activeKind.value) return
  const toRunnerPool = kind === delegatedKind.value
  saving.value = true
  try {
    await settings.update(
      props.axis === 'execution'
        ? { delegateAgentsToRunnerPool: toRunnerPool }
        : { delegateTestEnvToProvider: toRunnerPool },
    )
  } catch (e) {
    toast.add({
      title: t('settings.infrastructure.updateFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

const labelKey = computed(() =>
  props.axis === 'execution'
    ? 'settings.infrastructure.executionBackend.label'
    : 'settings.infrastructure.testEnvBackend.label',
)
</script>

<template>
  <section v-if="cap" class="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
    <h3 class="text-sm font-semibold text-slate-200">{{ t(labelKey) }}</h3>

    <!-- Local mode: a real choice the user can flip (writes the delegation setting). -->
    <div v-if="writable" class="space-y-1.5" :data-testid="`${axis}-backend-options`">
      <label
        v-for="kind in cap.available"
        :key="kind"
        class="flex items-start gap-2"
        :class="
          kind === delegatedKind && !delegatedRegistered
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer'
        "
      >
        <input
          type="radio"
          class="mt-1"
          :value="kind"
          :checked="kind === activeKind"
          :disabled="saving || (kind === delegatedKind && !delegatedRegistered)"
          @change="select(kind)"
        />
        <span class="min-w-0">
          <span class="text-sm text-slate-200">{{ labelFor(kind) }}</span>
          <span
            v-if="kind === delegatedKind && !delegatedRegistered"
            class="block text-[11px] text-amber-300/80"
          >
            {{ t('settings.infrastructure.registerHint') }}
          </span>
        </span>
      </label>
    </div>

    <!-- Worker/Node: the active backend is deployment/registration-driven, not a toggle. -->
    <p v-else class="text-sm text-slate-300" :data-testid="`${axis}-backend-active`">
      {{ t('settings.infrastructure.active', { backend: labelFor(activeKind) }) }}
    </p>
  </section>
</template>
