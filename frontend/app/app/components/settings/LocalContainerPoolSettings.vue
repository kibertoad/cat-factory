<script setup lang="ts">
// Local-mode-only: the warm-container pool + per-repo checkout reuse. These are a
// per-DEPLOYMENT singleton stored in the DB (they replaced the LOCAL_POOL_* / HARNESS_* env
// vars), so a developer tunes them here instead of editing .env. The warm pool keeps idle
// harness containers ready and re-leases one (preferring repo affinity) to each run — far
// faster startup than a cold container per run. Saving applies the new sizing to the running
// service immediately (live resize, no restart); in-flight runs keep the container they hold,
// and the checkout config applies to containers started after the save.
//
// Previously a standalone modal (LocalModeSettingsPanel); now folded into the Agent-containers
// tab of the Infrastructure window, since the warm pool IS the local agent-container runtime.
import { reactive, ref, watch } from 'vue'

const { t } = useI18n()
const store = useLocalSettingsStore()
const toast = useToast()

const saving = ref(false)

// Editable draft. `idleMinutes` and `cleanKeep` are friendlier renderings of the stored
// `pool.idleTtlMs` (ms) and `checkout.cleanKeep` (string[]).
const draft = reactive({
  size: 0,
  minWarm: 0,
  max: null as number | null,
  idleMinutes: 10,
  workspaceRoot: '/workspace',
  cleanKeep: 'node_modules,.venv,target,.gradle,.pnpm-store',
})

function syncDraft() {
  const s = store.settings
  if (!s) return
  draft.size = s.pool.size
  draft.minWarm = s.pool.minWarm
  draft.max = s.pool.max
  draft.idleMinutes = Math.round(s.pool.idleTtlMs / 60_000)
  draft.workspaceRoot = s.checkout.workspaceRoot
  draft.cleanKeep = s.checkout.cleanKeep.join(',')
}

// Load + hydrate the draft on mount (the tab only mounts in local mode).
void store.load().then(syncDraft)
watch(() => store.settings, syncDraft)

async function save() {
  const cleanKeep = draft.cleanKeep
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  saving.value = true
  try {
    await store.save({
      pool: {
        size: Math.max(0, Math.floor(draft.size)),
        minWarm: Math.max(0, Math.floor(draft.minWarm)),
        max: draft.max == null ? null : Math.max(0, Math.floor(draft.max)),
        idleTtlMs: Math.max(0, Math.floor(draft.idleMinutes * 60_000)),
      },
      checkout: { workspaceRoot: draft.workspaceRoot.trim() || '/workspace', cleanKeep },
    })
    toast.add({
      title: t('settings.localMode.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.localMode.toast.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6" data-testid="local-container-pool-settings">
    <i18n-t
      keypath="settings.localMode.intro"
      tag="p"
      class="text-xs text-slate-400"
      scope="global"
    >
      <template #poolVars>
        <code>LOCAL_POOL_*</code>
      </template>
      <template #harnessVars>
        <code>HARNESS_*</code>
      </template>
    </i18n-t>

    <!-- Warm container pool -->
    <section class="space-y-3">
      <div>
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('settings.localMode.pool.heading') }}
        </h4>
        <i18n-t
          keypath="settings.localMode.pool.description"
          tag="p"
          class="text-[11px] text-slate-400"
          scope="global"
        >
          <template #appleContainer>
            <code>container</code>
          </template>
        </i18n-t>
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UFormField
          :label="t('settings.localMode.pool.size.label')"
          :help="t('settings.localMode.pool.size.help')"
        >
          <UInput v-model.number="draft.size" type="number" :min="0" size="sm" />
        </UFormField>
        <UFormField
          :label="t('settings.localMode.pool.minWarm.label')"
          :help="t('settings.localMode.pool.minWarm.help')"
        >
          <UInput v-model.number="draft.minWarm" type="number" :min="0" size="sm" />
        </UFormField>
        <UFormField
          :label="t('settings.localMode.pool.max.label')"
          :help="t('settings.localMode.pool.max.help')"
        >
          <UInput
            v-model.number="draft.max"
            type="number"
            :min="0"
            size="sm"
            :placeholder="t('settings.localMode.pool.max.placeholder')"
          />
        </UFormField>
        <UFormField
          :label="t('settings.localMode.pool.idleTimeout.label')"
          :help="t('settings.localMode.pool.idleTimeout.help')"
        >
          <UInput v-model.number="draft.idleMinutes" type="number" :min="0" size="sm" />
        </UFormField>
      </div>
    </section>

    <!-- Checkout reuse -->
    <section class="space-y-3 border-t border-slate-800 pt-6">
      <div>
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('settings.localMode.checkout.heading') }}
        </h4>
        <p class="text-[11px] text-slate-400">
          {{ t('settings.localMode.checkout.description') }}
        </p>
      </div>
      <UFormField
        :label="t('settings.localMode.checkout.workspaceRoot.label')"
        :help="t('settings.localMode.checkout.workspaceRoot.help')"
      >
        <UInput v-model="draft.workspaceRoot" size="sm" placeholder="/workspace" />
      </UFormField>
      <UFormField
        :label="t('settings.localMode.checkout.cleanKeep.label')"
        :help="t('settings.localMode.checkout.cleanKeep.help')"
      >
        <UInput
          v-model="draft.cleanKeep"
          size="sm"
          placeholder="node_modules,.venv,target,.gradle,.pnpm-store"
        />
      </UFormField>
    </section>

    <div class="flex justify-end">
      <UButton color="primary" icon="i-lucide-save" :loading="saving" @click="save">
        {{ t('common.save') }}
      </UButton>
    </div>
  </div>
</template>
