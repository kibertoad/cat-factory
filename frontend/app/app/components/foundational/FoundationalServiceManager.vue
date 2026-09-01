<script setup lang="ts">
// Foundational-services manager (backend/docs/adr/0031-foundational-services.md), reused at two
// scopes: a board (`workspace`) and an `account`. Register the shared capabilities the
// organisation already runs, attach their API contracts (uploaded or synced from a repo), and —
// at the workspace scope only — review the MERGED catalog an Architect is handed and opt the
// board out of anything it should not design against.
//
// The tab split is the feature's own split, not a layout choice: "Catalog" is what an agent sees
// (identity + operation names, never a document body), while "This tier" is what this owner
// actually registers. Only a board gets the catalog tab — it is what runs agents — but BOTH
// scopes get the suppression list, because an account inherits the deployment's code-registered
// services exactly as a board inherits its account's.
import { computed, ref, watch } from 'vue'
import type { FoundationalServiceOwnerKind } from '~/types/domain'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'
import FoundationalServiceCatalogList from '~/components/foundational/FoundationalServiceCatalogList.vue'
import FoundationalServiceRegistry from '~/components/foundational/FoundationalServiceRegistry.vue'
import FoundationalServiceSources from '~/components/foundational/FoundationalServiceSources.vue'
import FoundationalSuppressions from '~/components/foundational/FoundationalSuppressions.vue'
import ServiceCatalogConnection from '~/components/foundational/ServiceCatalogConnection.vue'

const props = withDefaults(
  defineProps<{
    kind: FoundationalServiceOwnerKind
    ownerId: string
    /** Whether to show the merged-catalog tab (workspace scope only). */
    showCatalog?: boolean
  }>(),
  { showCatalog: false },
)

// The workspace scope follows the active board (singleton, shared with the navbar); the account
// scope uses an owner-keyed store so each account is isolated.
const catalog =
  props.kind === 'workspace'
    ? useFoundationalServicesStore()
    : useFoundationalServices(props.kind, props.ownerId)
const github = useGitHubStore()
const { t } = useI18n()

watch(
  () => props.ownerId,
  () => {
    void catalog.probe()
    // The repo pickers need the active board's installation state; probe once so they light up.
    void github.ensureProbed()
  },
  { immediate: true },
)

type Tab = 'catalog' | 'registry' | 'sources' | 'portal'
const tab = ref<Tab>(props.showCatalog ? 'catalog' : 'registry')

const ownerLabel = computed(() =>
  props.kind === 'workspace' ? t('foundational.owner.workspace') : t('foundational.owner.account'),
)

const tabs = computed(() => {
  const items = [
    { value: 'registry' as const, label: ownerLabel.value, slot: 'registry' },
    { value: 'sources' as const, label: t('foundational.tab.sources'), slot: 'sources' },
  ]
  // The developer-portal import is WORKSPACE-only, so it rides the same flag the merged catalog
  // does rather than a second one: the credential is workspace-keyed, and an account tab would
  // offer a connection the backend serves at no scope.
  if (!props.showCatalog) return items
  return [
    { value: 'catalog' as const, label: t('foundational.tab.catalog'), slot: 'catalog' },
    ...items,
    { value: 'portal' as const, label: t('foundational.tab.portal'), slot: 'portal' },
  ]
})

const activeTab = computed({
  get: () => tab.value,
  set: (v: string) => {
    tab.value = v as Tab
  },
})
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="foundational-manager">
    <!-- The catalog is opt-in; if a deployment has not wired it, say so rather than offering
         forms that would fail with a raw 503. -->
    <div
      v-if="catalog.available === false"
      class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400"
    >
      {{ t('foundational.unavailable') }}
    </div>

    <UTabs
      v-else
      v-model="activeTab"
      :items="tabs"
      variant="link"
      :ui="{ root: 'gap-4', list: 'overflow-x-auto' }"
    >
      <template #catalog>
        <div class="flex flex-col gap-4">
          <FoundationalServiceCatalogList />
          <FoundationalSuppressions :kind="props.kind" :owner-id="props.ownerId" />
        </div>
      </template>
      <template #registry>
        <div class="flex flex-col gap-4">
          <FoundationalServiceRegistry :kind="props.kind" :owner-id="props.ownerId" />
          <!-- A scope with no catalog tab still has to be able to see (and lift) what it is
               opting out of; with one, the list lives beside the catalog it explains. -->
          <FoundationalSuppressions
            v-if="!props.showCatalog"
            :kind="props.kind"
            :owner-id="props.ownerId"
          />
        </div>
      </template>
      <template #sources>
        <FoundationalServiceSources :kind="props.kind" :owner-id="props.ownerId" />
      </template>
      <template #portal>
        <ServiceCatalogConnection />
      </template>
    </UTabs>
  </div>
</template>
