<script setup lang="ts">
// The single tabbed "Infrastructure" window — now a TOP-LEVEL navbar destination (no longer
// reached through the Integrations hub). Its topical tabs:
//   - "Agent containers" — where repo-operating agent containers run. Shows the execution
//     backend selector, the runner-pool connection (ProviderConnectionTab), and — in local
//     mode — the warm-container-pool + checkout-reuse settings (the local agent-container
//     runtime, folded in from the former LocalModeSettingsPanel).
//   - "Test environments" — where the Tester's ephemeral environments run. Shows the test-env
//     backend selector, the environment-provider connection, and the guided per-service Docker
//     Compose setup (formerly a standalone "Environment setup" sidebar entry — it writes a
//     service's Compose recipe plus the workspace's Compose handler, so it belongs beside the
//     settings it edits rather than at the same level as them).
//   - "Shared stacks" — long-lived Compose infra a Tester environment attaches to, so it rides
//     the same probe as the environments tab (nothing to attach to without one).
//   - "Package registries" — the private npm registries a checkout installs from (formerly an
//     Integrations-hub row). What a container can resolve its dependencies from is part of the
//     execution environment, not an optional external system a workspace links in.
//   - "Capability credentials" — the deployment's tool servers (MCP) with a Test button each, above
//     the sealed per-workspace values behind the secrets a registered tool server or generative
//     binary integration declares. What an agent's tools authenticate as belongs beside where those
//     agents run, and it is `secrets.manage`-only (the READ included, since both halves name the
//     deployment's credential keys), so the tab is HIDDEN rather than disabled for anyone else.
// Local-specific affordances render inline, gated on `auth.localMode?.enabled`. A tab whose
// backend integration is disabled (503) simply doesn't render.
import { computed, ref, watch } from 'vue'
import type { InfrastructureTab } from '~/types/providerConnections'
import {
  infrastructureTabs,
  openInfrastructureTab,
  repinInfrastructureTab,
} from '~/components/settings/InfrastructureWindow.logic'
import InfrastructureBackendPicker from '~/components/settings/InfrastructureBackendPicker.vue'
import InfraHandlersConfigurator from '~/components/settings/InfraHandlersConfigurator.vue'
import DefaultProvisionTypeSection from '~/components/settings/DefaultProvisionTypeSection.vue'
import LocalContainerPoolSettings from '~/components/settings/LocalContainerPoolSettings.vue'
import SharedStacksPanel from '~/components/settings/SharedStacksPanel.vue'
import ComposeEnvironmentSetupSection from '~/components/settings/ComposeEnvironmentSetupSection.vue'
import PackageRegistriesPanel from '~/components/settings/PackageRegistriesPanel.vue'
import CapabilityCredentialsPanel from '~/components/settings/CapabilityCredentialsPanel.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useProviderConnectionsStore()
const auth = useAuthStore()
const packageRegistries = usePackageRegistriesStore()
const capabilityCredentials = useCapabilityCredentialsStore()
const toolServers = useToolServersStore()
const { canManageSecrets } = useWorkspaceAccess()

const open = computed({
  get: () => ui.infrastructureOpen,
  set: (v: boolean) => {
    if (!v) ui.closeProviderConnection()
  },
})

const isLocal = computed(() => auth.localMode?.enabled === true)

// The tabs are driven by the deployment's infrastructure capability (every facade reports
// execution + test-env backends), NOT the optional provider-connection probes — the execution-
// backend selector must show even when no runner-pool / environment connection is registered.
// The connect form inside each tab still gates on its own probe (see the template).
const agentsAvailable = computed(() => (auth.infrastructure?.execution.available.length ?? 0) > 0)
const envsAvailable = computed(() => (auth.infrastructure?.testEnv.available.length ?? 0) > 0)

// Tab presentation, keyed by the closed `InfrastructureTab` union so a new tab fails to compile
// until it is given a label and an icon. The labels are literal `t()` calls for the same reason
// they are not resolved in the logic module: a key assembled at runtime is invisible to the
// typed-message-key check.
const TAB_LABELS = computed<Record<InfrastructureTab, string>>(() => ({
  'runner-pool': t('settings.providerConnection.tabs.agentContainers'),
  environment: t('settings.providerConnection.tabs.testEnvironments'),
  'shared-stacks': t('settings.sharedStacks.tab'),
  'package-registries': t('settings.packageRegistries.tab'),
  'capability-credentials': t('settings.capabilityCredentials.tab'),
}))
const TAB_ICONS: Record<InfrastructureTab, string> = {
  'runner-pool': 'i-lucide-server-cog',
  environment: 'i-lucide-cloud',
  'shared-stacks': 'i-lucide-layers',
  'package-registries': 'i-lucide-package',
  'capability-credentials': 'i-lucide-key-round',
}

// `slot` mirrors `value` — the template names one `<template #…>` per tab value.
const tabs = computed(() =>
  infrastructureTabs({
    agents: agentsAvailable.value,
    environments: envsAvailable.value,
    // The module's own probe (the backend 503s with no encryption key), same gate as the
    // Integrations-hub row this replaced — an unconfigured backend shows no dead tab.
    packageRegistries: packageRegistries.available === true,
    // Two gates, and neither implies the other. `canManageSecrets` hides the tab from a member
    // who may not manage secrets (the view NAMES the deployment's credential keys, which is why
    // the backend gates the read too), and `hasSurface` hides a tab with nothing in it — the
    // panel is a checklist projected from the deployment's registered capabilities, so a build
    // that registers none has no credential to type.
    //
    // EITHER surface earns the tab. A tool server that declares no credential has nothing on the
    // checklist, and gating the tab on the checklist alone would leave the one server an operator
    // most wants to test unreachable — while a credential whose capability is a generative
    // integration has no tool-server row. Two questions, one tab, and neither is a subset of the
    // other.
    capabilityCredentials:
      canManageSecrets.value && (capabilityCredentials.hasSurface || toolServers.hasSurface),
  }).map((value) => ({
    value,
    label: TAB_LABELS.value[value],
    icon: TAB_ICONS[value],
    slot: value,
  })),
)
const tabValues = computed(() => tabs.value.map((x) => x.value))

const activeTab = ref<InfrastructureTab>(ui.infrastructureTab)

// Honour the deep-linked tab each time the window opens, falling back to the first available
// tab if the requested one is off.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    void store.ensureLoaded().catch(() => {})
    // The registries tab gates on this probe, so it has to resolve for the tab to appear at
    // all — the panel's own load is a no-op once this settled (`ensureLoaded` coalesces).
    // Swallowed here on purpose: the PANEL reports a load failure, and it can only do that
    // once the tab it lives in exists, so a probe failure has to leave the window itself alone.
    void packageRegistries.ensureLoaded().catch(() => {})
    // Same split as the registries probe: swallowed here (a failed probe means no tab, and the
    // window must still open), reported by the panel, which can only do that once its tab exists.
    // Not probed at all without the permission — the backend would refuse it, and asking would
    // put a 403 in every member's console on every open.
    if (canManageSecrets.value) {
      void capabilityCredentials.ensureLoaded().catch(() => {})
      void toolServers.ensureLoaded().catch(() => {})
    }
    activeTab.value = openInfrastructureTab(tabValues.value, ui.infrastructureTab)
  },
  { immediate: true },
)
// When availability resolves after open, re-pin onto a valid tab — but keep honouring the
// deep-linked request. The three availability probes resolve independently, so `tabs` can pass
// through a transient short list; only fall back to the first tab once loading settled.
watch([tabs, () => store.loaded], () => {
  activeTab.value = repinInfrastructureTab(
    tabValues.value,
    activeTab.value,
    ui.infrastructureTab,
    store.loaded,
  )
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.providerConnection.windowTitle')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <UTabs
          v-if="tabs.length"
          v-model="activeTab"
          :items="tabs"
          variant="link"
          :ui="{ root: 'gap-4' }"
          data-testid="infrastructure-tabs"
        >
          <template #runner-pool>
            <div class="space-y-4">
              <!-- One unified list of where agent containers run; the selected pool/cluster
                   reveals its connect form inline. -->
              <InfrastructureBackendPicker axis="execution" />
              <!-- Local mode: the warm-pool + checkout reuse ARE the host agent-container
                   runtime, so they live here rather than in a separate menu. -->
              <section v-if="isLocal" class="border-t border-slate-800 pt-4">
                <h3 class="mb-3 text-sm font-semibold text-slate-200">
                  {{ t('settings.localMode.title') }}
                </h3>
                <LocalContainerPoolSettings />
              </section>
            </div>
          </template>
          <template #environment>
            <div class="space-y-4">
              <!-- What this board's services PRODUCE by default. Comes first because it is the
                   question the per-type handlers below answer "how" for, and because a board that
                   has never chosen is the one the setup banner deep-links straight to here. -->
              <DefaultProvisionTypeSection />
              <!-- The Tester's environment is driven by each SERVICE's declared provision type
                   (the "what/where"); the workspace configures HOW each type is handled here —
                   the engine + connection per provision type, plus the custom-type catalog. -->
              <div class="border-t border-slate-800 pt-4">
                <InfraHandlersConfigurator />
              </div>
              <!-- The guided per-SERVICE Compose flow (formerly the standalone "Environment
                   setup" sidebar entry). Last, because it fills in one service's recipe on
                   top of the workspace-wide choices above. -->
              <div class="border-t border-slate-800 pt-4">
                <ComposeEnvironmentSetupSection />
              </div>
            </div>
          </template>
          <template #shared-stacks>
            <SharedStacksPanel />
          </template>
          <template #package-registries>
            <PackageRegistriesPanel />
          </template>
          <template #capability-credentials>
            <CapabilityCredentialsPanel />
          </template>
        </UTabs>

        <p v-else class="px-1 py-6 text-center text-sm text-slate-500">
          {{ t('settings.providerConnection.noneAvailable') }}
        </p>
      </div>
    </template>
  </UModal>
</template>
