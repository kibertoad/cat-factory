<script setup lang="ts">
import { ref, watch } from 'vue'
import AccountConfigNotLoaded from '~/components/layout/AccountConfigNotLoaded.vue'

// The account-wide FLOOR under each board's "may a run act as its initiator's own personal
// access token?" switch (admin only).
//
// Why a second tier at all: the workspace switch is edited with `settings.manage`, which a
// member elevated on one board holds — and the control exists precisely for the case where
// someone re-widens what the operator scoped. A floor a board admin cannot lift is the only
// version of it that binds. Effective = this permits AND the board permits.
//
// Left UNSET by default, deliberately. A personal token is the right credential for someone
// adopting cat-factory alone inside an org that has not adopted it: there is no App
// installation to inherit and no account admin to ask. Setting this is for the opposite case.
// See `backend/docs/security-model.md`.
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()

// Tri-state, and it must stay tri-state: "not set" is a real, distinct answer from "permitted".
// Collapsing it to a boolean would make every existing account look as though an admin had
// actively decided, and would write that decision on the next unrelated save.
const forbid = ref(false)
const saving = ref(false)

function hydrate() {
  forbid.value = store.view?.config?.allowInitiatorPat === false
}

const { loaded, loadFailed } = useAccountConfig(() => props.accountId)
watch(() => store.view, hydrate, { immediate: true })

async function save() {
  saving.value = true
  try {
    // Clearing the floor writes `undefined` rather than `true`, keeping "no opinion"
    // distinguishable from "explicitly permitted".
    await store.saveConfigPatch(props.accountId, {
      allowInitiatorPat: forbid.value ? false : undefined,
    })
    actionToast.success('settings.runCredentialPolicy.saved')
  } catch (e) {
    present(e, 'settings.runCredentialPolicy.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="store.available !== false" class="space-y-2" data-testid="account-run-credential">
    <h3 class="text-sm font-semibold text-default">
      {{ t('settings.runCredentialPolicy.heading') }}
    </h3>
    <p class="text-2xs text-muted">{{ t('settings.runCredentialPolicy.body') }}</p>

    <!-- Hidden until this account's config is in hand: a switch shown over a failed load reads
         as the stored floor, and flipping it could not be saved anyway. -->
    <template v-if="loaded">
      <label class="flex items-center gap-2">
        <USwitch v-model="forbid" size="sm" data-testid="account-forbid-initiator-pat" />
        <span class="text-sm text-default">{{ t('settings.runCredentialPolicy.toggle') }}</span>
      </label>

      <!-- What the choice actually costs, stated at the point of choosing rather than discovered
           later: attribution is a real feature, and turning this on is what trades it away. -->
      <p v-if="forbid" class="text-2xs text-app-warning-300">
        {{ t('settings.runCredentialPolicy.onHint') }}
      </p>
      <p v-else class="text-2xs text-dimmed">
        {{ t('settings.runCredentialPolicy.offHint') }}
      </p>
    </template>
    <AccountConfigNotLoaded v-else-if="loadFailed" data-testid="account-run-credential-unloaded" />

    <div class="flex justify-end">
      <UButton
        size="xs"
        icon="i-lucide-save"
        :loading="saving"
        :disabled="!loaded"
        data-testid="account-run-credential-save"
        @click="save"
      >
        {{ t('common.save') }}
      </UButton>
    </div>
  </div>
</template>
