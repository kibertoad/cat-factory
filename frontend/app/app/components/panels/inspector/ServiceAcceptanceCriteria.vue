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

const busy = ref(false)
const adding = ref(false)
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

onMounted(() => {
  store.ensureLoaded().catch(() => {})
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
  adding.value = false
}

async function add() {
  if (!draftValid.value) return
  busy.value = true
  try {
    await store.create(props.block.id, {
      title: draft.value.title.trim(),
      given: draft.value.given.trim(),
      when: draft.value.when.trim(),
      outcome: draft.value.outcome.trim(),
      tags: draft.value.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
    resetDraft()
    toast.add({
      title: t('inspector.acceptanceCriteria.addedToast'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('inspector.acceptanceCriteria.addFailed'), e)
  } finally {
    busy.value = false
  }
}

async function setStatus(
  criterion: ServiceAcceptanceCriterion,
  status: 'confirmed' | 'retired',
): Promise<void> {
  busy.value = true
  try {
    await store.update(props.block.id, criterion.id, { status })
  } catch (e) {
    notifyError(t('inspector.acceptanceCriteria.updateFailed'), e)
  } finally {
    busy.value = false
  }
}

async function remove(criterion: ServiceAcceptanceCriterion) {
  const noun = t('inspector.acceptanceCriteria.criterionNoun')
  if (!(await confirmAction('remove', noun))) return
  busy.value = true
  try {
    await store.remove(props.block.id, criterion.id)
    toastDone('remove', noun)
  } catch (e) {
    notifyError(t('inspector.acceptanceCriteria.deleteFailed'), e)
  } finally {
    busy.value = false
  }
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
        :disabled="adding || atCapacity"
        data-testid="acceptance-criteria-add"
        @click="adding = true"
      >
        {{ t('inspector.acceptanceCriteria.add') }}
      </UButton>
    </template>

    <div class="space-y-3">
      <p class="text-[11px] text-slate-500">
        {{ t('inspector.acceptanceCriteria.hint') }}
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
          <p class="mt-1 text-[11px] text-slate-500">
            <span v-if="criterion.given">{{
              t('inspector.acceptanceCriteria.given', { text: criterion.given })
            }}</span>
            {{ t('inspector.acceptanceCriteria.when', { text: criterion.when }) }}
            {{ t('inspector.acceptanceCriteria.outcome', { text: criterion.outcome }) }}
          </p>
          <div class="mt-2 flex gap-2">
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-check"
              :loading="busy"
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
              :loading="busy"
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
              icon="i-lucide-archive"
              :aria-label="t('inspector.acceptanceCriteria.retire')"
              :loading="busy"
              data-testid="acceptance-criterion-retire"
              @click="setStatus(criterion, 'retired')"
            />
            <UButton
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="t('inspector.acceptanceCriteria.remove')"
              :loading="busy"
              data-testid="acceptance-criterion-delete"
              @click="remove(criterion)"
            />
          </div>
        </div>
        <p class="mt-1 text-[11px] text-slate-500">
          <span v-if="criterion.given">{{
            t('inspector.acceptanceCriteria.given', { text: criterion.given })
          }}</span>
          {{ t('inspector.acceptanceCriteria.when', { text: criterion.when }) }}
          {{ t('inspector.acceptanceCriteria.outcome', { text: criterion.outcome }) }}
        </p>
        <div v-if="criterion.tags.length" class="mt-1 flex flex-wrap gap-1">
          <UBadge v-for="tag in criterion.tags" :key="tag" color="neutral" variant="soft" size="xs">
            {{ tag }}
          </UBadge>
        </div>
      </div>

      <p
        v-if="retired.length"
        class="text-[11px] text-slate-400"
        data-testid="acceptance-criteria-retired"
      >
        {{ t('inspector.acceptanceCriteria.retiredCount', { count: retired.length }) }}
      </p>

      <p
        v-if="criteria.length === 0 && !adding"
        class="text-[11px] text-slate-500"
        data-testid="acceptance-criteria-empty"
      >
        {{ t('inspector.acceptanceCriteria.empty') }}
      </p>

      <!-- The hand-authoring form. A criterion typed here arrives already confirmed. -->
      <div
        v-if="adding"
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
            :loading="busy"
            data-testid="acceptance-criterion-save"
            @click="add"
          >
            {{ t('inspector.acceptanceCriteria.save') }}
          </UButton>
        </div>
      </div>
    </div>
  </InspectorSection>
</template>
