<script setup lang="ts">
// The workspace's DEFAULT test-environment provisioning mechanism — the provision type stamped
// onto every newly added service frame so the operator declares it once per board instead of
// once per service. Lives at the top of the Infrastructure window's "Test environments" tab,
// above the per-type handler configurator, because it answers the question that comes FIRST:
// what do this board's services produce, before you configure how each type is handled.
//
// This is a SUGGESTION for new services, never a run-time override: the engine still reads only
// a service's own `provisioning`, so saving a different default here never changes what an
// existing service provisions (each stays editable in its inspector).
//
// The section opens on the workspace's recorded choice, or — with nothing recorded — on the first
// REGISTERED custom provider when the deployment brought one. All of that precedence lives in
// `utils/defaultProvisioning.ts` so it is unit-tested and shared with the banner that nags about
// the unset state. Nothing is persisted until the operator saves.
import { computed, ref, watch } from 'vue'
import type { ProvisionType } from '@cat-factory/contracts'
import {
  canSaveDefaultProvisioning,
  suggestDefaultProvisioning,
  type DefaultProvisioningSelection,
} from '~/utils/defaultProvisioning'

const { t } = useI18n()
const infra = useInfraConfigStore()
const settingsStore = useWorkspaceSettingsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()

onMounted(() => {
  void infra.ensureLoaded()
})

// The saved state, and the (unsaved) edit state seeded from it. Re-seeded whenever the saved
// choice or the custom-type catalog changes — the catalog arrives asynchronously, so without the
// second dependency a board whose only sensible answer is a registered provider would open unset
// and never pick it up.
const selection = ref<DefaultProvisioningSelection>({ type: null, manifestId: null })
watch(
  [() => settingsStore.settings, () => infra.customTypes],
  ([settings, customTypes]) => {
    selection.value = suggestDefaultProvisioning(settings, customTypes)
  },
  { immediate: true, deep: true },
)

// Whether what's on screen differs from what's stored — drives both the Save button and the
// "this is only a suggestion so far" hint, so a preselected-but-unsaved custom provider can
// never read as already configured.
const dirty = computed(
  () =>
    selection.value.type !== settingsStore.settings.defaultProvisionType ||
    (selection.value.manifestId ?? null) !==
      (settingsStore.settings.defaultProvisionManifestId ?? null),
)
const unset = computed(() => settingsStore.settings.defaultProvisionType == null)
const canSave = computed(() => canSaveDefaultProvisioning(selection.value) && dirty.value)

const PROVISION_TYPES = computed<{ value: ProvisionType; label: string }[]>(() => [
  { value: 'infraless', label: t('inspector.testConfig.provisionTypes.infraless') },
  { value: 'docker-compose', label: t('inspector.testConfig.provisionTypes.docker-compose') },
  { value: 'kubernetes', label: t('inspector.testConfig.provisionTypes.kubernetes') },
  { value: 'cloudflare', label: t('inspector.testConfig.provisionTypes.cloudflare') },
  { value: 'custom', label: t('inspector.testConfig.provisionTypes.custom') },
])

const customTypeItems = computed(() =>
  infra.customTypes.map((c) => ({ label: `${c.label} (${c.manifestId})`, value: c.manifestId })),
)

function setType(type: ProvisionType) {
  // Switching away from `custom` drops the pinned id, matching the server's normalisation — a
  // retained id would silently reappear on switching back.
  selection.value =
    type === 'custom'
      ? { type, manifestId: selection.value.manifestId ?? infra.customTypes[0]?.manifestId ?? null }
      : { type, manifestId: null }
}

function setManifestId(manifestId: string) {
  selection.value = { type: 'custom', manifestId: manifestId || null }
}

const saving = ref(false)
async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    await settingsStore.update({
      defaultProvisionType: selection.value.type,
      defaultProvisionManifestId: selection.value.manifestId,
    })
    toast.add({ title: t('settings.defaultProvision.saved'), color: 'success' })
  } catch (e) {
    present(e, 'settings.defaultProvision.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-3" data-testid="default-provision-section">
    <div>
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.defaultProvision.title') }}
      </h3>
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('settings.defaultProvision.hint') }}
      </p>
    </div>

    <div class="flex flex-wrap gap-1">
      <UButton
        v-for="p in PROVISION_TYPES"
        :key="p.value"
        :color="selection.type === p.value ? 'primary' : 'neutral'"
        :variant="selection.type === p.value ? 'soft' : 'ghost'"
        size="xs"
        :data-testid="`default-provision-type-${p.value}`"
        @click="setType(p.value)"
      >
        {{ p.label }}
      </UButton>
    </div>

    <div v-if="selection.type === 'custom'" class="space-y-1">
      <label class="text-[11px] text-slate-400">
        {{ t('inspector.testConfig.customManifestId') }}
      </label>
      <USelect
        v-if="customTypeItems.length"
        :model-value="selection.manifestId ?? ''"
        :items="customTypeItems"
        size="xs"
        class="w-full"
        data-testid="default-provision-manifest-id"
        :placeholder="t('inspector.testConfig.customManifestIdPlaceholder')"
        @update:model-value="(v: string) => setManifestId(v)"
      />
      <p v-else class="text-[11px] leading-snug text-amber-300/80">
        {{ t('inspector.testConfig.customNoTypes') }}
      </p>
    </div>

    <!-- A preselected suggestion must never read as already configured: say so explicitly while
         the workspace still has nothing stored. -->
    <p
      v-if="unset && selection.type"
      class="text-[11px] leading-snug text-amber-300/80"
      data-testid="default-provision-suggestion-hint"
    >
      {{ t('settings.defaultProvision.suggestionHint') }}
    </p>

    <div class="flex items-center gap-2">
      <UButton
        size="xs"
        color="primary"
        icon="i-lucide-check"
        :loading="saving"
        :disabled="!canSave"
        data-testid="default-provision-save"
        @click="save"
      >
        {{ t('settings.defaultProvision.save') }}
      </UButton>
      <span v-if="!unset && !dirty" class="text-[11px] text-slate-500">
        {{ t('settings.defaultProvision.savedState') }}
      </span>
    </div>
  </section>
</template>
