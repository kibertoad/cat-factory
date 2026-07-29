<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentPromptRevision } from '~/types/agent-prompts'
import { agentKindMeta } from '~/utils/catalog'
import AgentKindIcon from '~/components/pipeline/AgentKindIcon.vue'

// The per-workspace system-prompt editor for ONE agent kind, opened from the pipeline builder
// (where the kinds are actually chosen). It edits the SHIPPED track prompt only: the platform
// re-applies its own directives — the read-only guardrail, the answer-in-your-reply rule, the
// service's best-practice standards — on top of whatever is saved here, so they are neither
// shown nor editable and cannot be deleted by accident.
//
// History is the point, not a nicety: every save appends a revision and going back is another
// append, so nothing a user does here can lose the prompt their runs were on last week.

const props = defineProps<{ agentKind: string | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useToast()
const prompts = useAgentPromptsStore()

const open = computed({
  get: () => props.agentKind !== null,
  set: (v: boolean) => {
    if (!v) emit('close')
  },
})

/** The textarea's working copy. Seeded from the effective prompt each time the editor opens. */
const draft = ref('')
/**
 * The revision the working copy was lifted out of, when the user picked one from the history.
 * Cleared as soon as they type, because the saved text would then no longer BE that revision
 * and recording it would mislabel the entry the next reader tries to trace.
 */
const restoredFrom = ref<number | undefined>(undefined)
/** Whether the built-in is shown beside the editor for comparison. */
const showBuiltin = ref(false)

watch(
  () => props.agentKind,
  async (kind) => {
    if (!kind) {
      prompts.reset()
      return
    }
    showBuiltin.value = false
    restoredFrom.value = undefined
    draft.value = ''
    try {
      const detail = await prompts.load(kind)
      draft.value = detail?.effectiveText ?? ''
    } catch {
      toast.add({ title: t('agentPrompt.toast.loadFailed'), color: 'error' })
      emit('close')
    }
  },
  { immediate: true },
)

const detail = computed(() => prompts.detail)
const label = computed(() => (props.agentKind ? agentKindMeta(props.agentKind).label : ''))

/** The live prompt, so "no change" can be reported instead of appending an identical revision. */
const effective = computed(() => detail.value?.effectiveText ?? '')
const dirty = computed(() => draft.value.trim() !== effective.value.trim())
/** Nothing to revert to when the workspace is already running the shipped prompt. */
const canRevert = computed(() => detail.value?.customized === true)

function pick(revision: AgentPromptRevision) {
  // A null-text revision restores the built-in; every other one restores its own text.
  draft.value = revision.text ?? detail.value?.builtinText ?? ''
  restoredFrom.value = revision.revision
}

function useBuiltin() {
  draft.value = detail.value?.builtinText ?? ''
  restoredFrom.value = undefined
}

async function save() {
  const kind = props.agentKind
  if (!kind) return
  const text = draft.value.trim()
  try {
    // Saving text identical to the built-in is a REVERT, not a copy of it: storing the copy
    // would pin the workspace to today's wording and quietly stop it tracking the product's
    // own prompt as that is improved.
    const isBuiltin = text === (detail.value?.builtinText ?? '').trim()
    const saved = await prompts.save(kind, isBuiltin ? null : text, restoredFrom.value)
    draft.value = saved?.effectiveText ?? draft.value
    restoredFrom.value = undefined
    toast.add({ title: t('agentPrompt.toast.saved'), color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    const conflict =
      (error as { data?: { error?: { details?: { reason?: string } } } })?.data?.error?.details
        ?.reason === 'prompt_revision_conflict'
    toast.add({
      title: conflict ? t('agentPrompt.toast.conflict') : t('agentPrompt.toast.saveFailed'),
      color: 'error',
    })
    // The server's view already replaced the store's on a conflict, so re-seed the textarea
    // from what actually landed rather than leaving the user editing a lost revision.
    if (conflict) draft.value = prompts.detail?.effectiveText ?? draft.value
  }
}

async function revert() {
  const kind = props.agentKind
  if (!kind) return
  try {
    const saved = await prompts.save(kind, null)
    draft.value = saved?.effectiveText ?? draft.value
    restoredFrom.value = undefined
    toast.add({ title: t('agentPrompt.toast.reverted'), color: 'success' })
  } catch {
    toast.add({ title: t('agentPrompt.toast.saveFailed'), color: 'error' })
  }
}

const { d } = useI18n()
function revisionLabel(revision: AgentPromptRevision): string {
  return revision.text === null
    ? t('agentPrompt.revision.builtin', { n: revision.revision })
    : revision.restoredFrom !== undefined
      ? t('agentPrompt.revision.restored', { n: revision.revision, from: revision.restoredFrom })
      : t('agentPrompt.revision.edit', { n: revision.revision })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('agentPrompt.title', { agent: label })"
    :description="t('agentPrompt.description')"
    :ui="{ content: 'max-w-[92vw] sm:max-w-3xl lg:max-w-5xl' }"
  >
    <template #body>
      <div v-if="prompts.loadingDetail" class="py-8 text-center text-sm text-slate-400">
        {{ t('common.loading') }}
      </div>
      <div v-else-if="detail" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <AgentKindIcon v-if="agentKind" :kind="agentKind" icon-class="h-4 w-4" />
          <span class="font-medium text-slate-200">{{ label }}</span>
          <UBadge v-if="detail.builtinVersionLabel" color="neutral" variant="subtle" size="sm">
            {{ detail.builtinVersionLabel }}
          </UBadge>
          <UBadge :color="detail.customized ? 'warning' : 'neutral'" variant="subtle" size="sm">
            {{ detail.customized ? t('agentPrompt.customized') : t('agentPrompt.usingBuiltin') }}
          </UBadge>
        </div>

        <!-- What the platform adds on top is stated rather than shown: it is not editable, and
             a user who does not know it is there writes a prompt that fights it. -->
        <p class="text-[11px] leading-relaxed text-slate-500">
          {{ t('agentPrompt.managedNotice') }}
        </p>

        <UTextarea
          v-model="draft"
          :rows="16"
          autoresize
          :maxrows="24"
          class="font-mono"
          :placeholder="t('agentPrompt.placeholder')"
        />

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            color="primary"
            size="sm"
            icon="i-lucide-save"
            :loading="prompts.saving"
            :disabled="!dirty || !draft.trim()"
            @click="save"
          >
            {{ t('agentPrompt.save') }}
          </UButton>
          <UButton
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-rotate-ccw"
            :disabled="prompts.saving || !canRevert"
            @click="revert"
          >
            {{ t('agentPrompt.revert') }}
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-file-text"
            @click="useBuiltin"
          >
            {{ t('agentPrompt.loadBuiltin') }}
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :icon="showBuiltin ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            @click="showBuiltin = !showBuiltin"
          >
            {{ showBuiltin ? t('agentPrompt.hideBuiltin') : t('agentPrompt.showBuiltin') }}
          </UButton>
          <span v-if="restoredFrom !== undefined" class="text-[11px] text-slate-400">
            {{ t('agentPrompt.restoringFrom', { n: restoredFrom }) }}
          </span>
        </div>

        <div v-if="showBuiltin" class="rounded-md border border-slate-800 bg-slate-950/60 p-2">
          <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('agentPrompt.builtinHeading') }}
          </h4>
          <pre
            class="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300"
            >{{ detail.builtinText }}</pre>
        </div>

        <div>
          <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('agentPrompt.historyHeading') }}
          </h4>
          <p v-if="!detail.revisions.length" class="text-[11px] text-slate-500">
            {{ t('agentPrompt.historyEmpty') }}
          </p>
          <ul v-else class="max-h-52 divide-y divide-slate-800 overflow-y-auto text-xs">
            <li
              v-for="revision in detail.revisions"
              :key="revision.revision"
              class="flex items-center gap-2 py-1.5"
            >
              <UBadge
                v-if="revision.revision === detail.revisions[0]?.revision"
                color="primary"
                variant="subtle"
                size="sm"
              >
                {{ t('agentPrompt.live') }}
              </UBadge>
              <span class="min-w-0 flex-1 truncate text-slate-300">
                {{ revisionLabel(revision) }}
              </span>
              <span class="shrink-0 text-[11px] text-slate-500">
                {{ d(new Date(revision.createdAt), 'short') }}
              </span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-history"
                :title="t('agentPrompt.restoreTooltip')"
                @click="pick(revision)"
              >
                {{ t('agentPrompt.restore') }}
              </UButton>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </UModal>
</template>
