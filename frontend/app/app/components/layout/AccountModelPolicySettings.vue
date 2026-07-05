<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { MODEL_FAMILY_POLICY_PRESETS } from '@cat-factory/contracts'
import type {
  AccountRegion,
  ModelFamily,
  ModelFamilyPolicy,
  ModelPolicyMode,
} from '~/types/accountSettings'

// Account-wide model-family allow/block policy (admin only). Constrains which LLM families
// the account's teams may run; a residency-guaranteed route (`trustedProviders`) can exempt
// an otherwise-blocked family. Region-grouped built-in presets are one-click templates the
// admin applies into the editable policy. Mounted only where the deployment supports it
// (hosted / mothership — never plain local mode), gated by the parent on the infra flag.
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const toast = useToast()
const { t } = useI18n()

// The family / region / mode / trusted-provider domains, pinned to the contract unions so a
// new enum member fails the typecheck here (via the exhaustive label maps below).
const FAMILIES = [
  'claude',
  'openai',
  'gemini',
  'llama',
  'qwen',
  'kimi',
  'deepseek',
  'glm',
] as const satisfies readonly ModelFamily[]
const REGIONS = ['usa', 'europe', 'china', 'other'] as const satisfies readonly AccountRegion[]
const MODES = ['off', 'blocklist', 'allowlist'] as const satisfies readonly ModelPolicyMode[]
const TRUSTED_PROVIDERS = ['bedrock'] as const

// Exhaustive enum→key maps (drift guard): every member resolves to a static literal `t()`
// key, so adding a family/region/mode without a label fails the typecheck on the Record.
const familyLabels = computed<Record<ModelFamily, string>>(() => ({
  claude: t('settings.modelPolicy.families.claude'),
  openai: t('settings.modelPolicy.families.openai'),
  gemini: t('settings.modelPolicy.families.gemini'),
  llama: t('settings.modelPolicy.families.llama'),
  qwen: t('settings.modelPolicy.families.qwen'),
  kimi: t('settings.modelPolicy.families.kimi'),
  deepseek: t('settings.modelPolicy.families.deepseek'),
  glm: t('settings.modelPolicy.families.glm'),
}))
const regionLabels = computed<Record<AccountRegion, string>>(() => ({
  usa: t('settings.modelPolicy.regions.usa'),
  europe: t('settings.modelPolicy.regions.europe'),
  china: t('settings.modelPolicy.regions.china'),
  other: t('settings.modelPolicy.regions.other'),
}))
const modeLabels = computed<Record<ModelPolicyMode, string>>(() => ({
  off: t('settings.modelPolicy.modes.off'),
  blocklist: t('settings.modelPolicy.modes.blocklist'),
  allowlist: t('settings.modelPolicy.modes.allowlist'),
}))
const providerLabels: Record<(typeof TRUSTED_PROVIDERS)[number], string> = {
  bedrock: t('settings.modelPolicy.providers.bedrock'),
}

const modeItems = computed(() => MODES.map((m) => ({ label: modeLabels.value[m], value: m })))
const regionItems = computed(() => REGIONS.map((r) => ({ label: regionLabels.value[r], value: r })))

// Editable local state (hydrated from the stored policy).
const mode = ref<ModelPolicyMode>('off')
const region = ref<AccountRegion>('other')
const families = ref<ModelFamily[]>([])
const trusted = ref<string[]>([])
const saving = ref(false)

function hydrate() {
  const p = store.view?.config?.modelPolicy
  mode.value = p?.mode ?? 'off'
  region.value = p?.region ?? 'other'
  families.value = [...(p?.families ?? [])]
  trusted.value = [...(p?.trustedProviders ?? [])]
}

// The presets offered for the currently-selected region.
const regionPresets = computed(() =>
  MODEL_FAMILY_POLICY_PRESETS.filter((preset) => preset.region === region.value),
)

function toggleFamily(fam: ModelFamily) {
  families.value = families.value.includes(fam)
    ? families.value.filter((x) => x !== fam)
    : [...families.value, fam]
}
function toggleTrusted(provider: string) {
  trusted.value = trusted.value.includes(provider)
    ? trusted.value.filter((x) => x !== provider)
    : [...trusted.value, provider]
}

function applyPreset(policy: ModelFamilyPolicy) {
  mode.value = policy.mode
  families.value = [...policy.families]
  trusted.value = [...policy.trustedProviders]
}

onMounted(async () => {
  // The sibling deployment-settings panel loads the store on mount too; guard against a
  // double-load being unnecessary by only loading when the view isn't present yet.
  if (!store.view && store.available !== false) {
    try {
      await store.load(props.accountId)
    } catch {
      // The deployment-settings panel surfaces the load error; stay quiet here.
    }
  }
  hydrate()
})
watch(() => store.view, hydrate)

async function save() {
  const policy: ModelFamilyPolicy = {
    mode: mode.value,
    // Families are irrelevant when the policy is off; keep them so a later re-enable
    // restores the admin's selection rather than silently emptying it.
    families: families.value,
    trustedProviders: trusted.value,
    region: region.value,
  }
  saving.value = true
  try {
    // `config` fully replaces the stored non-secret config, so carry the rest forward.
    await store.save(props.accountId, { config: { ...store.view?.config, modelPolicy: policy } })
    toast.add({
      title: t('settings.modelPolicy.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.modelPolicy.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    v-if="store.available !== false"
    data-testid="account-model-policy"
    class="space-y-3 border-t border-slate-800 pt-6"
  >
    <div>
      <h4 class="text-sm font-semibold text-slate-200">{{ t('settings.modelPolicy.title') }}</h4>
      <p class="text-[11px] text-slate-400">{{ t('settings.modelPolicy.description') }}</p>
    </div>

    <!-- Region + apply-preset templates -->
    <div class="space-y-2">
      <label class="text-[11px] font-medium text-slate-300">
        {{ t('settings.modelPolicy.regionLabel') }}
      </label>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <USelect v-model="region" :items="regionItems" value-key="value" size="sm" />
      </div>
      <div v-if="regionPresets.length" class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] text-slate-400">{{ t('settings.modelPolicy.applyPreset') }}</span>
        <UButton
          v-for="preset in regionPresets"
          :key="preset.id"
          color="neutral"
          variant="subtle"
          size="xs"
          icon="i-lucide-wand-2"
          :title="t(`settings.modelPolicy.presets.${preset.id}.description`)"
          @click="applyPreset(preset.policy)"
        >
          {{ t(`settings.modelPolicy.presets.${preset.id}.label`) }}
        </UButton>
      </div>
    </div>

    <!-- Mode -->
    <div class="space-y-2">
      <label class="text-[11px] font-medium text-slate-300">
        {{ t('settings.modelPolicy.modeLabel') }}
      </label>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <USelect v-model="mode" :items="modeItems" value-key="value" size="sm" />
      </div>
    </div>

    <!-- Families -->
    <div v-if="mode !== 'off'" class="space-y-2">
      <label class="text-[11px] font-medium text-slate-300">
        {{
          mode === 'blocklist'
            ? t('settings.modelPolicy.familiesBlockLabel')
            : t('settings.modelPolicy.familiesAllowLabel')
        }}
      </label>
      <div class="grid grid-cols-2 gap-1 sm:grid-cols-4">
        <UCheckbox
          v-for="fam in FAMILIES"
          :key="fam"
          :model-value="families.includes(fam)"
          :label="familyLabels[fam]"
          size="sm"
          @update:model-value="toggleFamily(fam)"
        />
      </div>
    </div>

    <!-- Trusted (residency-guaranteed) routes -->
    <div v-if="mode !== 'off'" class="space-y-2">
      <label class="text-[11px] font-medium text-slate-300">
        {{ t('settings.modelPolicy.trustedLabel') }}
      </label>
      <p class="text-[11px] text-slate-400">{{ t('settings.modelPolicy.trustedHint') }}</p>
      <div class="grid grid-cols-2 gap-1 sm:grid-cols-4">
        <UCheckbox
          v-for="provider in TRUSTED_PROVIDERS"
          :key="provider"
          :model-value="trusted.includes(provider)"
          :label="providerLabels[provider]"
          size="sm"
          @update:model-value="toggleTrusted(provider)"
        />
      </div>
    </div>

    <div class="flex gap-2">
      <UButton
        color="primary"
        size="xs"
        icon="i-lucide-save"
        :loading="saving"
        data-testid="account-model-policy-save"
        @click="save"
      >
        {{ t('common.save') }}
      </UButton>
    </div>
  </section>
</template>
