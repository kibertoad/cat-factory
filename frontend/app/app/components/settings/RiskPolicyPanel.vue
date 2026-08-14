<script setup lang="ts">
// Workspace settings: the risk policy library a task picks its auto-merge policy from (the `merger`
// step compares a PR's assessment against the resolved policy).
//
// Since ADR 0055 the library has two tiers. The board's OWN policies are fully editable here; the
// ones it INHERITS from its account are read-only, with the two actions a board has over a row it
// does not own (clone it in, or hide it). A third section lists what is currently hidden, because a
// hidden policy is by construction absent from the library above and would otherwise be a one-way
// door.
import { computed, onMounted, ref } from 'vue'
import type { RiskPolicyLibraryEntry, UpdateRiskPolicyInput } from '~/types/merge'
import { riskPolicyCopyName } from '~/utils/riskPolicy'
import RiskPolicyCreateForm from '~/components/settings/RiskPolicyCreateForm.vue'
import RiskPolicyEditorRow from '~/components/settings/RiskPolicyEditorRow.vue'
import RiskPolicyInheritedRow from '~/components/settings/RiskPolicyInheritedRow.vue'

const { t } = useI18n()

const store = useRiskPoliciesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

/**
 * Which single control is mid-request, keyed `<policyId>[:<action>]`.
 *
 * Per ACTION and not merely per policy, because a row carries several independent buttons: keyed by
 * policy alone, promoting the in-app default spun the unattended button too and told the operator a
 * change they had not asked for was in flight.
 */
const busy = ref<string | null>(null)
const creating = ref(false)

const own = computed(() => store.presets.filter((p) => p.tier === 'workspace'))
const inherited = computed(() => store.presets.filter((p) => p.tier === 'account'))

/**
 * Whether the hidden-policy read FAILED, as opposed to answering nothing.
 *
 * The two must not render the same. An empty list means the board hides nothing; a failed read means
 * it may be hiding policies this panel cannot show, and silence there would leave an operator who
 * just hid one looking for it in a section that claims to be complete. Not a toast, because this
 * fires on open and only powers an undo affordance: a line in the section itself is the honest place.
 */
const suppressionsFailed = ref(false)

// What the board hides is not in the snapshot (a hidden policy is absent from the library by
// construction), so it is read when the panel opens.
onMounted(() => {
  void store
    .loadSuppressions()
    .then(() => (suppressionsFailed.value = false))
    .catch(() => (suppressionsFailed.value = true))
})

/** Run one guarded action under a busy key, reporting a failure through the shared funnel. */
async function run(key: string, titleKey: string, action: () => Promise<unknown>) {
  busy.value = key
  try {
    await action()
  } catch (e) {
    present(e, titleKey)
  } finally {
    busy.value = null
  }
}

async function save(policy: RiskPolicyLibraryEntry, patch: UpdateRiskPolicyInput) {
  await run(policy.id, 'settings.riskPolicy.toast.saveFailed', async () => {
    await store.update(policy.id, patch)
    toast.add({
      title: t('settings.riskPolicy.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  })
}

function makeDefault(policy: RiskPolicyLibraryEntry) {
  return run(`${policy.id}:default`, 'settings.riskPolicy.toast.defaultFailed', () =>
    store.update(policy.id, { isDefault: true }),
  )
}

/**
 * Promote this policy to the UNATTENDED default: the one a task that pins none resolves when nothing
 * is watching the run (a start over the public API, a tracker dispatch, a schedule fire).
 *
 * Its own action rather than a second meaning for the button above, because the two defaults are
 * independent: a board can run one posture in the app and another for the work it never sees.
 */
function makeUnattendedDefault(policy: RiskPolicyLibraryEntry) {
  return run(`${policy.id}:unattended`, 'settings.riskPolicy.toast.defaultFailed', () =>
    store.update(policy.id, { isUnattendedDefault: true }),
  )
}

async function remove(policy: RiskPolicyLibraryEntry) {
  const ok = await confirm({
    title: t('settings.riskPolicy.confirmDelete.title'),
    description: t('settings.riskPolicy.confirmDelete.body', { name: policy.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  await run(policy.id, 'settings.riskPolicy.toast.deleteFailed', () => store.remove(policy.id))
}

async function create(input: Parameters<typeof store.create>[0]) {
  creating.value = true
  try {
    await store.create(input)
    toast.add({
      title: t('settings.riskPolicy.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.createFailed')
  } finally {
    creating.value = false
  }
}

/**
 * Clone an inherited policy into the board. The copy's NAME is composed here because the backend
 * does not localize prose: it defaults to the source's name, and this states in the reader's own
 * language that the row is a copy. `riskPolicyCopyName` holds it inside the contract's length limit,
 * which the marker would otherwise push a long source name past.
 */
function clone(policy: RiskPolicyLibraryEntry) {
  return run(`${policy.id}:clone`, 'settings.riskPolicy.toast.cloneFailed', async () => {
    const name = riskPolicyCopyName(policy.name, (source) =>
      t('settings.riskPolicy.inherited.copyName', { name: source }),
    )
    await store.clone(policy.id, name)
    toast.add({
      title: t('settings.riskPolicy.toast.cloned'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  })
}

/**
 * Hide an inherited policy. Confirmed, because a task that already pinned it falls back to the
 * board's default for its scope — the same thing a deleted local policy does — and that is a change
 * of merge posture on existing work rather than a change to a list.
 */
async function hide(policy: RiskPolicyLibraryEntry) {
  const ok = await confirm({
    title: t('settings.riskPolicy.confirmHide.title'),
    description: t('settings.riskPolicy.confirmHide.body', { name: policy.name }),
    confirmLabel: t('settings.riskPolicy.inherited.hide'),
    icon: 'i-lucide-eye-off',
  })
  if (!ok) return
  await run(`${policy.id}:hide`, 'settings.riskPolicy.toast.hideFailed', () =>
    store.hide(policy.id),
  )
}

function unhide(presetId: string) {
  return run(`${presetId}:unhide`, 'settings.riskPolicy.toast.unhideFailed', () =>
    store.unhide(presetId),
  )
}
</script>

<template>
  <div class="space-y-4" data-testid="risk-policy-panel">
    <i18n-t
      keypath="settings.riskPolicy.intro"
      tag="p"
      class="text-xs text-slate-400"
      scope="global"
    >
      <template #merger>
        <span class="text-slate-300">{{ t('settings.riskPolicy.mergerAgent') }}</span>
      </template>
    </i18n-t>

    <!-- Inherited FIRST: they are the org's posture, and a board reading its own list wants to see
         what it is working from before what it has changed. -->
    <section v-if="inherited.length > 0" class="space-y-2">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('settings.riskPolicy.inherited.heading') }}
      </p>
      <p class="text-[11px] text-slate-500">{{ t('settings.riskPolicy.inherited.hint') }}</p>
      <RiskPolicyInheritedRow
        v-for="policy in inherited"
        :key="policy.id"
        :policy="policy"
        :busy="busy"
        @clone="clone(policy)"
        @hide="hide(policy)"
      />
    </section>

    <section class="space-y-4">
      <p
        v-if="inherited.length > 0"
        class="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
      >
        {{ t('settings.riskPolicy.own.heading') }}
      </p>
      <RiskPolicyEditorRow
        v-for="policy in own"
        :key="policy.id"
        :policy="policy"
        :busy="busy"
        :show-defaults="true"
        @save="save(policy, $event)"
        @promote="makeDefault(policy)"
        @promote-unattended="makeUnattendedDefault(policy)"
        @remove="remove(policy)"
      />
    </section>

    <!-- What this board is hiding. Rendered only when there IS something, and each entry says
         whether it still shadows an account policy: one whose policy the account has since withdrawn
         withholds nothing, and reading it as a live opt-out would misstate what the board is doing. -->
    <section v-if="store.suppressions.length > 0 || suppressionsFailed" class="space-y-2">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('settings.riskPolicy.hidden.heading') }}
      </p>
      <p v-if="suppressionsFailed" class="text-[11px] text-amber-400">
        {{ t('settings.riskPolicy.hidden.loadFailed') }}
      </p>
      <div
        v-for="entry in store.suppressions"
        :key="entry.id"
        class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2"
        data-testid="risk-policy-hidden-row"
        :data-policy-id="entry.id"
      >
        <span class="flex-1 truncate text-[12px] text-slate-300">{{ entry.name }}</span>
        <span v-if="!entry.inherited" class="text-[11px] text-slate-500">
          {{ t('settings.riskPolicy.hidden.withdrawn') }}
        </span>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-eye"
          :loading="busy === `${entry.id}:unhide`"
          data-testid="risk-policy-unhide"
          @click="unhide(entry.id)"
        >
          {{ t('settings.riskPolicy.hidden.restore') }}
        </UButton>
      </div>
    </section>

    <RiskPolicyCreateForm :busy="creating" @create="create($event)" />
  </div>
</template>
