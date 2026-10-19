<script setup lang="ts">
// The account tier of the runner pool, under the Agent containers connect form. A deployment can
// declare one pool per ACCOUNT, and every board of that account with no pool of its own uses it
// unless the board opts out (`inheritAccountRunnerPool`). This section says which of the three
// states the board is in and offers the one move each state has:
//   - inherited: the board uses the account's pool → opt out (an override, so advanced mode or
//     once set; the board then runs agents nowhere until it registers its own).
//   - own pool: the board's own registration wins → choose, before removing it, whether the board
//     then falls back to the account's pool (the backend's default is no).
//   - opted out: no pool, though the account has one → opt back in (the way back, so every tier).
// Renders nothing when the account has no pool, or the board has no account.
import { computed, ref } from 'vue'
import { showOverrideField } from '~/utils/uiMode'

/** Whether removing the board's own pool falls back to the account's. Read by the remove action. */
const fallBackToAccount = defineModel<boolean>('fallBackToAccount', { default: false })

const { t } = useI18n()
const store = useProviderConnectionsStore()
const settings = useWorkspaceSettingsStore()
const uiMode = useUiModeStore()
const { canManageSettings } = useWorkspaceAccess()
const { present } = usePipelineErrorToast()

const accountPool = computed(() => store.accountPoolFor('runner-pool'))
const connection = computed(() => store.connectionFor('runner-pool'))
const inherit = computed(() => settings.settings.inheritAccountRunnerPool)

const state = computed<'inherited' | 'own' | 'optedOut' | null>(() => {
  if (!accountPool.value) return null
  if (connection.value?.source === 'account') return 'inherited'
  if (connection.value) return 'own'
  return inherit.value ? null : 'optedOut'
})

// Opting out overrides the inherited default, so basic mode shows it only once it is set; the
// way back (opting in) is never hidden.
const canOptOut = computed(
  () =>
    canManageSettings.value && showOverrideField(uiMode.isAdvanced, inherit.value ? null : false),
)

const saving = ref(false)
async function setInherit(value: boolean) {
  saving.value = true
  try {
    await store.setInheritAccountRunnerPool(value)
  } catch (e) {
    present(e, 'settings.infrastructure.updateFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    v-if="state && accountPool"
    class="space-y-2 rounded-md border border-muted bg-default/50 px-3 py-2 text-xs"
    :data-testid="`runner-pool-account-${state}`"
  >
    <template v-if="state === 'inherited'">
      <p class="text-default">
        {{ t('settings.providerConnection.accountPool.inherited', { label: accountPool.label }) }}
      </p>
      <template v-if="canOptOut">
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-unlink"
          :loading="saving"
          data-testid="runner-pool-opt-out"
          @click="setInherit(false)"
        >
          {{ t('settings.providerConnection.accountPool.optOut') }}
        </UButton>
        <p class="text-2xs text-muted">
          {{ t('settings.providerConnection.accountPool.optOutHint') }}
        </p>
      </template>
    </template>

    <template v-else-if="state === 'own'">
      <p class="text-muted">
        {{
          t('settings.providerConnection.accountPool.alsoAvailable', { label: accountPool.label })
        }}
      </p>
      <UCheckbox
        v-model="fallBackToAccount"
        :label="t('settings.providerConnection.accountPool.fallBack')"
        data-testid="runner-pool-fall-back"
      />
    </template>

    <template v-else>
      <p class="text-default">
        {{ t('settings.providerConnection.accountPool.optedOut', { label: accountPool.label }) }}
      </p>
      <UButton
        v-if="canManageSettings"
        color="primary"
        variant="soft"
        size="xs"
        icon="i-lucide-link"
        :loading="saving"
        data-testid="runner-pool-opt-in"
        @click="setInherit(true)"
      >
        {{ t('settings.providerConnection.accountPool.optIn') }}
      </UButton>
    </template>
  </section>
</template>
