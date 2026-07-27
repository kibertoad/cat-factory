<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import {
  ACCEPTANCE_CRITERIA_MAX_PER_FRAME,
  type ServiceAcceptanceCriterion,
} from '~/types/acceptanceCriteria'

// Per-service (frame) ACCEPTANCE CRITERIA: the durable given/when/outcome statements of required
// behaviour this service has accumulated. CONFIRMED criteria ride every dispatch's prompt (so the
// spec-writer, coder and reviewer know what the service must keep doing) and the tester returns a
// per-criterion verdict the PR verification report renders as a criterion → evidence table.
//
// The panel is a TRIAGE surface first and an editor second: the accretion pass files criteria it
// extracted from settled requirements reviews as `proposed`, and the confirm/retire decision is
// what turns them from inert candidates into something that steers agents. So proposed criteria
// are pinned to the top with their two decisions inline, rather than being one status dropdown
// among many fields.
//
// Keyed by THIS block's id (service frames only — a task resolves criteria up the frame chain).
const props = defineProps<{ block: Block }>()

const store = useAcceptanceCriteriaStore()
const toast = useToast()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

/**
 * Which criteria have a write in flight, BY ID — not one panel-wide flag. Triage is a rapid
 * sequence of per-row clicks, and a shared flag spins every other row's buttons on each one,
 * which reads as the whole list having become unresponsive.
 */
const busyIds = ref(new Set<string>())
/** The hand-authoring form: `'new'` while adding, a criterion id while editing that one. */
const editing = ref<string | null>(null)
const showRetired = ref(false)
const draft = ref({ title: '', given: '', when: '', outcome: '', tags: '' })

const criteria = computed(() => store.forBlock(props.block.id))
/** Proposed first — they are the ones asking the human for a decision. */
const proposed = computed(() => criteria.value.filter((c) => c.status === 'proposed'))
const confirmed = computed(() => criteria.value.filter((c) => c.status === 'confirmed'))
const retired = computed(() => criteria.value.filter((c) => c.status === 'retired'))
const atCapacity = computed(() => criteria.value.length >= ACCEPTANCE_CRITERIA_MAX_PER_FRAME)
/** A criterion needs a headline, a trigger and an observable outcome to be verifiable. */
const draftValid = computed(
  () =>
    draft.value.title.trim() !== '' &&
    draft.value.when.trim() !== '' &&
    draft.value.outcome.trim() !== '',
)

function isBusy(id: string): boolean {
  return busyIds.value.has(id)
}

/** Run a per-criterion write with that row — and only that row — marked busy. */
async function withRow(id: string, failureKey: string, run: () => Promise<unknown>) {
  busyIds.value = new Set(busyIds.value).add(id)
  try {
    await run()
  } catch (e) {
    notifyError(t(failureKey), e)
  } finally {
    const next = new Set(busyIds.value)
    next.delete(id)
    busyIds.value = next
  }
}

/** The one-line rendering of a criterion. ONE key per whole sentence — clause order and
 * punctuation differ by language, so the three clauses can never be concatenated key by key. */
function statementOf(criterion: ServiceAcceptanceCriterion): string {
  const parts = { given: criterion.given, when: criterion.when, outcome: criterion.outcome }
  return criterion.given.trim()
    ? t('inspector.acceptanceCriteria.statement', parts)
    : t('inspector.acceptanceCriteria.statementNoGiven', parts)
}

// REFRESH, not load-once: the `proposed` queue this panel exists to triage is written by the
// post-review accretion pass mid-run, with no live event to announce it — a store that latched
// after its first success would show the queue empty until a full page reload.
onMounted(() => {
  store.refresh().catch(() => {})
})

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

function resetDraft() {
  draft.value = { title: '', given: '', when: '', outcome: '', tags: '' }
  editing.value = null
}

function startAdd() {
  resetDraft()
  editing.value = 'new'
}

/** Open the same form over an existing criterion. Wording drifts as a service learns what it
 * actually promises, and retire-then-retype loses the id every verdict and report joins on. */
function startEdit(criterion: ServiceAcceptanceCriterion) {
  draft.value = {
    title: criterion.title,
    given: criterion.given,
    when: criterion.when,
    outcome: criterion.outcome,
    tags: criterion.tags.join(', '),
  }
  editing.value = criterion.id
}

function draftPayload() {
  return {
    title: draft.value.title.trim(),
    given: draft.value.given.trim(),
    when: draft.value.when.trim(),
    outcome: draft.value.outcome.trim(),
    tags: draft.value.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  }
}

async function save() {
  if (!draftValid.value || !editing.value) return
  const target = editing.value
  const creating = target === 'new'
  await withRow(
    target,
    creating
      ? 'inspector.acceptanceCriteria.addFailed'
      : 'inspector.acceptanceCriteria.updateFailed',
    async () => {
      if (creating) await store.create(props.block.id, draftPayload())
      else await store.update(props.block.id, target, draftPayload())
      resetDraft()
      toast.add({
        title: t(
          creating
            ? 'inspector.acceptanceCriteria.addedToast'
            : 'inspector.acceptanceCriteria.updatedToast',
        ),
        icon: 'i-lucide-check',
        color: 'success',
      })
    },
  )
}

async function setStatus(
  criterion: ServiceAcceptanceCriterion,
  status: 'confirmed' | 'retired',
): Promise<void> {
  await withRow(criterion.id, 'inspector.acceptanceCriteria.updateFailed', () =>
    store.update(props.block.id, criterion.id, { status }),
  )
}

async function remove(criterion: ServiceAcceptanceCriterion) {
  const noun = t('inspector.acceptanceCriteria.criterionNoun')
  if (!(await confirmAction('remove', noun))) return
  await withRow(criterion.id, 'inspector.acceptanceCriteria.deleteFailed', async () => {
    await store.remove(props.block.id, criterion.id)
    toastDone('remove', noun)
  })
}
</script>

<template>
  <InspectorSection
    v-if="store.available !== false"
    :title="t('inspector.acceptanceCriteria.title')"
    :hint="t('inspector.acceptanceCriteria.sectionHint')"
    data-testid="service-acceptance-criteria"
  >
    <template #actions>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plus"
        :disabled="editing !== null || atCapacity"
        data-testid="acceptance-criteria-add"
        @click="startAdd"
      >
        {{ t('inspector.acceptanceCriteria.add') }}
      </UButton>
    </template>

    <div class="space-y-3">
      <p class="text-[11px] text-slate-500">
        {{ t('inspector.acceptanceCriteria.hint') }}
      </p>

      <!-- A swallowed load failure would render as an empty list, which reads exactly like a
           service that has no criteria — say which it is. -->
      <p
        v-if="store.failed"
        class="text-[11px] text-rose-600 dark:text-rose-400"
        data-testid="acceptance-criteria-load-failed"
      >
        {{ t('inspector.acceptanceCriteria.loadFailed') }}
      </p>

      <!-- Proposed: the triage queue the accretion pass fills. -->
      <div v-if="proposed.length" class="space-y-2" data-testid="acceptance-criteria-proposed">
        <p class="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {{ t('inspector.acceptanceCriteria.proposedHeading', { count: proposed.length }) }}
        </p>
        <div
          v-for="criterion in proposed"
          :key="criterion.id"
          class="rounded border border-amber-300/60 bg-amber-50/40 p-2 dark:border-amber-700/50 dark:bg-amber-950/20"
          data-testid="acceptance-criterion-row"
        >
          <p class="text-xs font-medium">{{ criterion.title }}</p>
          <p class="mt-1 text-[11px] text-slate-500">{{ statementOf(criterion) }}</p>
          <div class="mt-2 flex gap-2">
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-check"
              :loading="isBusy(criterion.id)"
              data-testid="acceptance-criterion-confirm"
              @click="setStatus(criterion, 'confirmed')"
            >
              {{ t('inspector.acceptanceCriteria.confirm') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-archive"
              :loading="isBusy(criterion.id)"
              data-testid="acceptance-criterion-retire"
              @click="setStatus(criterion, 'retired')"
            >
              {{ t('inspector.acceptanceCriteria.retire') }}
            </UButton>
          </div>
        </div>
      </div>

      <!-- Confirmed: the live contract that reaches agent prompts. -->
      <div
        v-for="criterion in confirmed"
        :key="criterion.id"
        class="rounded border border-slate-200 p-2 dark:border-slate-700"
        data-testid="acceptance-criterion-row"
      >
        <div class="flex items-start justify-between gap-2">
          <p class="text-xs font-medium">{{ criterion.title }}</p>
          <div class="flex shrink-0 gap-1">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-pencil"
              :aria-label="t('inspector.acceptanceCriteria.edit')"
              :disabled="editing !== null"
              data-testid="acceptance-criterion-edit"
              @click="startEdit(criterion)"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-archive"
              :aria-label="t('inspector.acceptanceCriteria.retire')"
              :loading="isBusy(criterion.id)"
              data-testid="acceptance-criterion-retire"
              @click="setStatus(criterion, 'retired')"
            />
            <UButton
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="t('inspector.acceptanceCriteria.remove')"
              :loading="isBusy(criterion.id)"
              data-testid="acceptance-criterion-delete"
              @click="remove(criterion)"
            />
          </div>
        </div>
        <p class="mt-1 text-[11px] text-slate-500">{{ statementOf(criterion) }}</p>
        <div v-if="criterion.tags.length" class="mt-1 flex flex-wrap gap-1">
          <UBadge v-for="tag in criterion.tags" :key="tag" color="neutral" variant="soft" size="xs">
            {{ tag }}
          </UBadge>
        </div>
      </div>

      <!-- Retired criteria stay reachable: retiring is the RECOMMENDED alternative to deleting,
           and the accretion pass will never re-propose a title it already holds — so a criterion
           retired by mistake would otherwise be gone for good with no way back. -->
      <div v-if="retired.length" class="space-y-1" data-testid="acceptance-criteria-retired">
        <UButton
          color="neutral"
          variant="link"
          size="xs"
          class="px-0 text-[11px] text-slate-400"
          data-testid="acceptance-criteria-retired-toggle"
          @click="showRetired = !showRetired"
        >
          {{ t('inspector.acceptanceCriteria.retiredCount', { count: retired.length }) }} ·
          {{
            showRetired
              ? t('inspector.acceptanceCriteria.hideRetired')
              : t('inspector.acceptanceCriteria.showRetired')
          }}
        </UButton>
        <div
          v-for="criterion in showRetired ? retired : []"
          :key="criterion.id"
          class="flex items-start justify-between gap-2 rounded border border-dashed border-slate-200 p-2 dark:border-slate-700"
          data-testid="acceptance-criterion-row"
        >
          <div class="min-w-0">
            <p class="text-xs font-medium text-slate-400 line-through">{{ criterion.title }}</p>
            <p class="mt-1 text-[11px] text-slate-400">{{ statementOf(criterion) }}</p>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-undo-2"
            :aria-label="t('inspector.acceptanceCriteria.restore')"
            :loading="isBusy(criterion.id)"
            data-testid="acceptance-criterion-restore"
            @click="setStatus(criterion, 'confirmed')"
          />
        </div>
      </div>

      <p
        v-if="criteria.length === 0 && editing === null"
        class="text-[11px] text-slate-500"
        data-testid="acceptance-criteria-empty"
      >
        {{ t('inspector.acceptanceCriteria.empty') }}
      </p>

      <!-- The hand-authoring form, shared by add and edit (`editing` holds `'new'` or the id). A
           criterion typed here arrives already confirmed. -->
      <div
        v-if="editing !== null"
        class="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-700"
      >
        <UFormField :label="t('inspector.acceptanceCriteria.titleLabel')">
          <UInput
            v-model="draft.title"
            size="sm"
            class="w-full"
            data-testid="acceptance-criterion-title"
          />
        </UFormField>
        <UFormField :label="t('inspector.acceptanceCriteria.givenLabel')">
          <UInput
            v-model="draft.given"
            size="sm"
            class="w-full"
            data-testid="acceptance-criterion-given"
          />
        </UFormField>
        <UFormField :label="t('inspector.acceptanceCriteria.whenLabel')">
          <UInput
            v-model="draft.when"
            size="sm"
            class="w-full"
            data-testid="acceptance-criterion-when"
          />
        </UFormField>
        <UFormField :label="t('inspector.acceptanceCriteria.outcomeLabel')">
          <UInput
            v-model="draft.outcome"
            size="sm"
            class="w-full"
            data-testid="acceptance-criterion-outcome"
          />
        </UFormField>
        <UFormField
          :label="t('inspector.acceptanceCriteria.tagsLabel')"
          :hint="t('inspector.acceptanceCriteria.tagsHint')"
        >
          <UInput
            v-model="draft.tags"
            size="sm"
            class="w-full"
            data-testid="acceptance-criterion-tags"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" size="xs" @click="resetDraft">
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            variant="soft"
            size="xs"
            icon="i-lucide-save"
            :disabled="!draftValid"
            :loading="editing !== null && isBusy(editing)"
            data-testid="acceptance-criterion-save"
            @click="save"
          >
            {{
              editing === 'new'
                ? t('inspector.acceptanceCriteria.save')
                : t('inspector.acceptanceCriteria.saveEdit')
            }}
          </UButton>
        </div>
      </div>
    </div>
  </InspectorSection>
</template>
