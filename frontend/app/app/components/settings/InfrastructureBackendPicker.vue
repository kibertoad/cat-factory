<script setup lang="ts">
// ONE flat radio list per infrastructure axis — the single picker that replaces the old
// two-step "where it runs" radio + "runner/environment backend" dropdown. Each item is a
// concrete destination with a one-line description, so there is no more hidden second list:
//   - execution axis → where agent containers run: the facade built-in (local Docker /
//     Cloudflare Containers), the registered backend kinds (Kubernetes, a custom HTTP runner
//     pool, plus any deployment-registered CUSTOM kind), and — in local mode — a low-config
//     "Local Kubernetes (k3s)" preset.
//   - testEnv axis   → where the Tester's ephemeral environments run: the built-in
//     (in-container docker-compose) + the registered backend kinds.
//
// The backend kinds come from the workspace snapshot (`providerConnections.backendKindsFor`),
// so a custom kind a deployment registered shows up as a first-class radio item. Selecting a
// pool/cluster item reveals its connect form inline (driven through ProviderConnectionTab). In
// LOCAL MODE the choice is a real per-workspace toggle (the `delegate*` settings) — but we
// DEFER writing `delegate=true` until a connection is actually registered, so a half-configured
// pick never routes runs to a non-existent pool. Off-local (Worker/Node) the active backend is
// deployment/registration-driven, so the radio doesn't write the toggle — it only reveals the
// connect forms — and a read-only "Active: …" line states what's effectively routing.
import { computed, ref, watch } from 'vue'
import type { ExecutionBackendKind, TestEnvBackendKind } from '@cat-factory/contracts'
import ProviderConnectionTab from '~/components/settings/ProviderConnectionTab.vue'

const props = defineProps<{ axis: 'execution' | 'testEnv' }>()

const { t } = useI18n()
const auth = useAuthStore()
const settings = useWorkspaceSettingsStore()
const providerConnections = useProviderConnectionsStore()
const toast = useToast()

type BackendKind = ExecutionBackendKind | TestEnvBackendKind
// A radio item: the built-in facade runtime, one per registered backend kind (built-in +
// custom), or the synthetic local-k3s preset. `backendKind` is the slug passed to the connect
// tab (absent on the built-in, which means "don't delegate"); `preset` prefills the k8s form.
interface PickerItem {
  id: string
  backendKind?: string
  preset?: 'k3s'
  label: string
  desc: string
}

// The built-in facade runtimes carry localized labels + descriptions. i18n leaf keys are
// spelled as literals so the typed-message-keys check stays live.
const BUILTIN_KEYS: Record<BackendKind, { label: string; desc: string }> = {
  'local-docker': {
    label: 'settings.infrastructure.executionBackend.local-docker',
    desc: 'settings.infrastructure.executionBackend.local-dockerDesc',
  },
  'cloudflare-containers': {
    label: 'settings.infrastructure.executionBackend.cloudflare-containers',
    desc: 'settings.infrastructure.executionBackend.cloudflare-containersDesc',
  },
  'runner-pool': {
    label: 'settings.infrastructure.executionBackend.runner-pool',
    desc: 'settings.infrastructure.executionBackend.runner-poolDesc',
  },
  'local-compose': {
    label: 'settings.infrastructure.testEnvBackend.local-compose',
    desc: 'settings.infrastructure.testEnvBackend.local-composeDesc',
  },
  'environment-provider': {
    label: 'settings.infrastructure.testEnvBackend.environment-provider',
    desc: 'settings.infrastructure.testEnvBackend.environment-providerDesc',
  },
}
// The built-in `kubernetes` backend kind's localized label/desc, per axis.
const KUBERNETES_KEYS: Record<'execution' | 'testEnv', { label: string; desc: string }> = {
  execution: {
    label: 'settings.infrastructure.executionBackend.kubernetes',
    desc: 'settings.infrastructure.executionBackend.kubernetesDesc',
  },
  testEnv: {
    label: 'settings.infrastructure.testEnvBackend.kubernetes',
    desc: 'settings.infrastructure.testEnvBackend.kubernetesDesc',
  },
}
// k3s is an execution-only preset (the env k8s config can't be reduced to low-config), so a
// single catalog key serves it — no dead test-env keys.
const K3S_KEYS = {
  label: 'settings.infrastructure.executionBackend.k3s',
  desc: 'settings.infrastructure.executionBackend.k3sDesc',
}
// The Docker Compose env backend is test-env-only (it stands the app's own compose stack up as
// a Tester target). Its desc carries the actionable "when to use this" + the local-only caveat.
const COMPOSE_KEYS = {
  label: 'settings.infrastructure.testEnvBackend.compose',
  desc: 'settings.infrastructure.testEnvBackend.composeDesc',
}

const cap = computed<{ available: BackendKind[]; active: BackendKind } | null>(() => {
  const c = auth.infrastructure?.[props.axis]
  return c ? { available: c.available as BackendKind[], active: c.active as BackendKind } : null
})
const isLocal = computed(() => auth.localMode?.enabled === true)
const suggestedImage = computed(() => auth.infrastructure?.execution.suggestedExecutorImage)

// The kind reached by "delegating" away from the on-machine default + its connection kind.
const delegatedKind = computed<BackendKind>(() =>
  props.axis === 'execution' ? 'runner-pool' : 'environment-provider',
)
const connectionKind = computed<'runner-pool' | 'environment'>(() =>
  props.axis === 'execution' ? 'runner-pool' : 'environment',
)
// The built-in (the available option that isn't the delegated one), if this facade has one.
const builtinKind = computed<BackendKind | null>(
  () => cap.value?.available.find((k) => k !== delegatedKind.value) ?? null,
)
const connection = computed(() => providerConnections.connectionFor(connectionKind.value))
const connectionRegistered = computed(() => !!connection.value)
// Pool/cluster items can be configured only when the deployment supports delegation AND the
// connect integration is enabled (not 503).
const poolConfigurable = computed(
  () =>
    (cap.value?.available.includes(delegatedKind.value) ?? false) &&
    providerConnections.isAvailable(connectionKind.value),
)

// The delegation flag is a genuine per-workspace toggle ONLY in local mode.
const writable = computed(() => isLocal.value && (cap.value?.available.length ?? 0) > 1)
const delegated = computed(() =>
  props.axis === 'execution'
    ? settings.settings.delegateAgentsToRunnerPool
    : settings.settings.delegateTestEnvToProvider,
)

// The effective active backend (matches the prior ExecutionBackendSelector logic): local
// mode follows the toggle; off-local the delegated backend is active when its pool is
// registered, else the deployment default.
const effectiveActive = computed<BackendKind | null>(() => {
  if (!cap.value) return builtinKind.value
  if (writable.value) return delegated.value ? delegatedKind.value : builtinKind.value
  if (cap.value.available.includes(delegatedKind.value) && connectionRegistered.value) {
    return delegatedKind.value
  }
  return cap.value.active
})

// Localized label/desc for a built-in backend kind; null for a CUSTOM kind (which uses its
// snapshot label and has no description).
function backendKindKeys(kind: string): { label: string; desc: string } | null {
  if (kind === 'kubernetes') return KUBERNETES_KEYS[props.axis]
  if (kind === 'manifest') return BUILTIN_KEYS[delegatedKind.value]
  // Docker Compose only ever registers on the test-env axis (it's an EnvironmentProvider).
  if (kind === 'compose' && props.axis === 'testEnv') return COMPOSE_KEYS
  return null
}

// The radio item the current state maps to (an item id). A stored connection reads back as its
// own backend-kind slug; k3s is a one-shot prefill, never re-derived.
const derivedItem = computed<string>(() => {
  if (effectiveActive.value === delegatedKind.value) return connection.value?.kind ?? 'kubernetes'
  return 'builtin'
})

const selected = ref<string>(derivedItem.value)
// Re-sync when the derived state changes (e.g. after a save/remove or a settings flip
// elsewhere). A pending pool/k3s pick before save doesn't move `derivedItem`, so the user's
// selection survives until a connection is registered.
watch(derivedItem, (v) => {
  selected.value = v
})

const items = computed<PickerItem[]>(() => {
  const out: PickerItem[] = []
  if (builtinKind.value) {
    const k = BUILTIN_KEYS[builtinKind.value]
    out.push({ id: 'builtin', label: t(k.label), desc: t(k.desc) })
  }
  if (poolConfigurable.value) {
    for (const opt of providerConnections.backendKindsFor(connectionKind.value)) {
      const keys = backendKindKeys(opt.kind)
      out.push({
        id: opt.kind,
        backendKind: opt.kind,
        label: keys ? t(keys.label) : opt.label,
        desc: keys ? t(keys.desc) : '',
      })
    }
    // The k3s low-config preset prefills the RUNNER k8s form; the env k8s config (manifest
    // source + URL derivation) can't be reduced to low-config, so it's execution-only.
    if (isLocal.value && props.axis === 'execution') {
      out.push({
        id: 'k3s',
        backendKind: 'kubernetes',
        preset: 'k3s',
        label: t(K3S_KEYS.label),
        desc: t(K3S_KEYS.desc),
      })
    }
  }
  return out
})

// The active-line label: prefer the registered connection's concrete kind over the generic
// "delegated" label so "Active: Kubernetes cluster" reads truthfully.
const activeLabel = computed(() => {
  const c = connection.value
  if (effectiveActive.value === delegatedKind.value && c?.kind) {
    const keys = backendKindKeys(c.kind)
    if (keys) return t(keys.label)
    const opt = providerConnections
      .backendKindsFor(connectionKind.value)
      .find((o) => o.kind === c.kind)
    return opt?.label ?? c.kind
  }
  const kind = effectiveActive.value
  return kind ? t(BUILTIN_KEYS[kind].label) : ''
})

const saving = ref(false)

async function setDelegate(value: boolean) {
  saving.value = true
  try {
    await settings.update(
      props.axis === 'execution'
        ? { delegateAgentsToRunnerPool: value }
        : { delegateTestEnvToProvider: value },
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

async function select(id: string) {
  selected.value = id
  if (!writable.value) return // off-local: reveal the form, but don't flip a toggle.
  if (id === 'builtin') {
    await setDelegate(false)
    return
  }
  // Pool/cluster pick: only commit delegation now if a pool is already registered; otherwise
  // defer to onConnected so we never route to a non-existent pool (the amber hint nags).
  if (connectionRegistered.value) await setDelegate(true)
}

// Emitted by ProviderConnectionTab after a connection is successfully registered: now it's
// safe to activate delegation for the pending pick.
async function onConnected() {
  if (writable.value && selected.value !== 'builtin' && !delegated.value) await setDelegate(true)
}

// Which connect form ProviderConnectionTab should show, and the k3s prefill signal.
const selectedItem = computed<PickerItem | undefined>(() =>
  items.value.find((i) => i.id === selected.value),
)
const showConnectForm = computed(() => !!selectedItem.value?.backendKind && poolConfigurable.value)
const selectedBackendKind = computed(() => selectedItem.value?.backendKind ?? 'manifest')
const selectedPreset = computed(() => selectedItem.value?.preset)
// Nag when a pool item is picked in local mode but no pool is registered to back it.
const showRegisterHint = computed(
  () => writable.value && selected.value !== 'builtin' && !connectionRegistered.value,
)

const labelKey = computed(() =>
  props.axis === 'execution'
    ? 'settings.infrastructure.executionBackend.label'
    : 'settings.infrastructure.testEnvBackend.label',
)
</script>

<template>
  <section v-if="cap" class="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
    <h3 class="text-sm font-semibold text-slate-200">{{ t(labelKey) }}</h3>

    <!-- Off-local: the active backend is deployment/registration-driven; state it plainly. -->
    <p v-if="!writable" class="text-sm text-slate-300" :data-testid="`${axis}-backend-active`">
      {{ t('settings.infrastructure.active', { backend: activeLabel }) }}
    </p>

    <div class="space-y-1.5" :data-testid="`${axis}-backend-options`">
      <label v-for="item in items" :key="item.id" class="flex cursor-pointer items-start gap-2">
        <input
          type="radio"
          class="mt-1"
          :value="item.id"
          :checked="item.id === selected"
          :disabled="saving"
          :data-testid="`${axis}-backend-${item.id}`"
          @change="select(item.id)"
        />
        <span class="min-w-0">
          <span class="text-sm text-slate-200">{{ item.label }}</span>
          <span v-if="item.desc" class="block text-[11px] text-slate-400">{{ item.desc }}</span>
        </span>
      </label>
    </div>

    <p v-if="showRegisterHint" class="text-[11px] text-amber-300/80">
      {{ t('settings.infrastructure.registerHint') }}
    </p>

    <!-- The connect form for the selected pool/cluster, driven through the shared tab. -->
    <ProviderConnectionTab
      v-if="showConnectForm"
      :kind="connectionKind"
      :backend-kind="selectedBackendKind"
      :preset="selectedPreset"
      :suggested-image="suggestedImage"
      @connected="onConnected"
    />
  </section>
</template>
