<script setup lang="ts">
// The single tabbed "Infrastructure" window. It merges what used to be two separate
// Integrations-Hub entries — the self-hosted runner pool (container agents) and the
// ephemeral-environment provider (Tester environments) — into one surface, because the
// same custom pool typically backs both jobs, so configuring them together reflects
// reality. Each provider gets its own tab (ProviderConnectionTab); a tab whose backend
// integration is disabled (503) simply doesn't render.
//
// The local-mode delegation toggles are cross-cutting (one per concern), so they live at
// the TOP of the window rather than buried in one tab — removing the old awkward
// cross-link hint that pointed from the runner-pool screen back to the env screen.
import { computed, ref, watch } from 'vue'
import type { ProviderConnectionKind } from '~/types/providerConnections'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import ProviderConnectionTab from '~/components/settings/ProviderConnectionTab.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useProviderConnectionsStore()
const auth = useAuthStore()
const settings = useWorkspaceSettingsStore()
const toast = useToast()

const open = computed({
  get: () => ui.infrastructureOpen,
  set: (v: boolean) => {
    if (!v) ui.closeProviderConnection()
  },
})
const back = useIntegrationBack(open)

// Each concern gates on its own availability probe; an unavailable tab isn't offered.
const agentsAvailable = computed(() => store.isAvailable('runner-pool'))
const envsAvailable = computed(() => store.isAvailable('environment'))

const tabs = computed(() => {
  const out: { value: ProviderConnectionKind; label: string; icon: string; slot: string }[] = []
  if (agentsAvailable.value)
    out.push({
      value: 'runner-pool',
      label: t('settings.providerConnection.tabs.containerAgents'),
      icon: 'i-lucide-server-cog',
      slot: 'runner-pool',
    })
  if (envsAvailable.value)
    out.push({
      value: 'environment',
      label: t('settings.providerConnection.tabs.testEnvironments'),
      icon: 'i-lucide-cloud',
      slot: 'environment',
    })
  return out
})

const activeTab = ref<ProviderConnectionKind>(ui.infrastructureTab)

// Honour the deep-linked tab each time the window opens (e.g. the banner's per-kind
// "Configure…" button), falling back to the first available tab if the requested one is off.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    void store.ensureLoaded().catch(() => {})
    const requested = ui.infrastructureTab
    const available = tabs.value.map((x) => x.value)
    activeTab.value = available.includes(requested) ? requested : (available[0] ?? requested)
  },
  { immediate: true },
)
// When availability resolves after open, re-pin onto a valid tab — but keep honouring the
// deep-linked request. The two availability probes resolve independently, so `tabs` can pass
// through a transient single-tab list (e.g. the runner-pool probe lands a tick before the
// environment one). We must NOT let that transient list steal focus from a still-loading
// requested tab, so only fall back to the first tab once loading has fully settled.
watch([tabs, () => store.loaded], () => {
  const list = tabs.value
  if (list.some((x) => x.value === activeTab.value)) return
  const requested = ui.infrastructureTab
  if (list.some((x) => x.value === requested)) {
    activeTab.value = requested
  } else if (store.loaded && list.length) {
    activeTab.value = list[0]!.value
  }
})

// --- Local-mode infrastructure delegation (cross-cutting; shown only in local mode) ---
// In local mode this is where a developer chooses, per workspace, whether to run on this
// machine (host Docker for agents, in-container docker-compose for the Tester) or delegate
// to an external service. Each toggle is enabled only once its provider is registered.
const isLocal = computed(() => auth.localMode?.enabled === true)
const runnerPoolRegistered = computed(() => !!store.connectionFor('runner-pool'))
const envRegistered = computed(() => !!store.connectionFor('environment'))
const savingDelegation = ref(false)

async function setDelegation(patch: {
  delegateAgentsToRunnerPool?: boolean
  delegateTestEnvToProvider?: boolean
}) {
  savingDelegation.value = true
  try {
    await settings.update(patch)
  } catch (e) {
    toast.add({
      title: t('settings.providerConnection.delegation.updateFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    savingDelegation.value = false
  }
}

function selectTab(kind: ProviderConnectionKind) {
  activeTab.value = kind
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.providerConnection.windowTitle')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('settings.providerConnection.windowTitle')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <!-- Local-mode delegation: the local-vs-external choice for BOTH container agents
             AND the Tester's ephemeral environments, made once here at the top. -->
        <section
          v-if="isLocal"
          class="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3"
        >
          <div>
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('settings.providerConnection.delegation.title') }}
            </h3>
            <p class="mt-1 text-[11px] text-slate-400">
              {{ t('settings.providerConnection.delegation.intro') }}
            </p>
          </div>

          <!-- Container agents → self-hosted runner pool -->
          <div class="space-y-1">
            <label class="flex items-center gap-2">
              <USwitch
                size="sm"
                :model-value="settings.settings.delegateAgentsToRunnerPool"
                :disabled="savingDelegation || !runnerPoolRegistered"
                @update:model-value="(v) => setDelegation({ delegateAgentsToRunnerPool: v })"
              />
              <span class="text-sm text-slate-200">
                {{ t('settings.providerConnection.delegation.agentsToggle') }}
              </span>
            </label>
            <p class="pl-9 text-[11px] text-slate-400">
              {{ t('settings.providerConnection.delegation.agentsHint') }}
              <template v-if="!runnerPoolRegistered">
                <i18n-t
                  keypath="settings.providerConnection.delegation.registerPoolPrompt"
                  tag="span"
                  scope="global"
                >
                  <template #link>
                    <button
                      type="button"
                      class="text-sky-400 underline underline-offset-2 hover:text-sky-300"
                      @click="selectTab('runner-pool')"
                    >
                      {{ t('settings.providerConnection.delegation.registerPoolLink') }}
                    </button>
                  </template>
                </i18n-t>
              </template>
            </p>
          </div>

          <!-- Tester environments → environment provider -->
          <div class="space-y-1">
            <label class="flex items-center gap-2">
              <USwitch
                size="sm"
                :model-value="settings.settings.delegateTestEnvToProvider"
                :disabled="savingDelegation || !envRegistered"
                @update:model-value="(v) => setDelegation({ delegateTestEnvToProvider: v })"
              />
              <span class="text-sm text-slate-200">
                {{ t('settings.providerConnection.delegation.envToggle') }}
              </span>
            </label>
            <p class="pl-9 text-[11px] text-slate-400">
              {{ t('settings.providerConnection.delegation.envHint') }}
            </p>
          </div>
        </section>

        <UTabs
          v-if="tabs.length"
          v-model="activeTab"
          :items="tabs"
          variant="link"
          :ui="{ root: 'gap-4' }"
          data-testid="infrastructure-tabs"
        >
          <template #runner-pool>
            <ProviderConnectionTab kind="runner-pool" />
          </template>
          <template #environment>
            <ProviderConnectionTab kind="environment" />
          </template>
        </UTabs>

        <p v-else class="px-1 py-6 text-center text-sm text-slate-500">
          {{ t('settings.providerConnection.noneAvailable') }}
        </p>
      </div>
    </template>
  </UModal>
</template>
