<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

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
const toast = useToast()
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

onMounted(async () => {
  if (!store.view && store.available !== false) await store.load(props.accountId)
  hydrate()
})
watch(() => store.view, hydrate)

async function save() {
  saving.value = true
  try {
    // `config` fully REPLACES the stored non-secret config, so the rest is carried forward —
    // the same contract the model-policy editor honours. Clearing the floor writes `undefined`
    // rather than `true`, keeping "no opinion" distinguishable from "explicitly permitted".
    await store.save(props.accountId, {
      config: {
        ...store.view?.config,
        ...(forbid.value ? { allowInitiatorPat: false } : { allowInitiatorPat: undefined }),
      },
    })
    toast.add({ title: t('settings.runCredentialPolicy.saved'), color: 'success' })
  } catch (e) {
    present(e, 'settings.runCredentialPolicy.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="store.available !== false" class="space-y-2" data-testid="account-run-credential">
    <h3 class="text-sm font-semibold text-slate-200">
      {{ t('settings.runCredentialPolicy.heading') }}
    </h3>
    <p class="text-[11px] text-slate-400">{{ t('settings.runCredentialPolicy.body') }}</p>

    <label class="flex items-center gap-2">
      <USwitch v-model="forbid" size="sm" data-testid="account-forbid-initiator-pat" />
      <span class="text-sm text-slate-200">{{ t('settings.runCredentialPolicy.toggle') }}</span>
    </label>

    <!-- What the choice actually costs, stated at the point of choosing rather than discovered
         later: attribution is a real feature, and turning this on is what trades it away. -->
    <p v-if="forbid" class="text-[11px] text-amber-300">
      {{ t('settings.runCredentialPolicy.onHint') }}
    </p>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('settings.runCredentialPolicy.offHint') }}
    </p>

    <div class="flex justify-end">
      <UButton
        color="primary"
        size="xs"
        icon="i-lucide-save"
        :loading="saving"
        data-testid="account-run-credential-save"
        @click="save"
      >
        {{ t('common.save') }}
      </UButton>
    </div>
  </div>
</template>
