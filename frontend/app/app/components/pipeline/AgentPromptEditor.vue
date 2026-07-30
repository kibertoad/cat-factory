<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentPromptRevision } from '~/types/agent-prompts'
import { agentKindMeta } from '~/utils/catalog'
import AgentKindIcon from '~/components/pipeline/AgentKindIcon.vue'
import OutputBudgetInput from '~/components/pipeline/OutputBudgetInput.vue'
import {
  draftForRevision,
  isDirty,
  isRevisionConflict,
  saveIntent,
} from '~/components/pipeline/AgentPromptEditor.logic'

// The per-workspace system-prompt editor for ONE agent kind, opened from the pipeline builder
// (where the kinds are actually chosen). It edits the SHIPPED track prompt only: the platform
// re-applies its own directives on top of whatever is saved here, so they cannot be deleted by
// accident — and it SHOWS that appended text (`detail.appendedText`, measured server-side from
// the real composition) rather than describing it, so what the editor promises can never drift
// from what the dispatch actually sends.
//
// History is the point, not a nicety: every save appends a revision and going back is another
// append, so nothing a user does here can lose the prompt their runs were on last week.
//
// The rules about WHAT to send live in ./AgentPromptEditor.logic.ts, unit-tested there: each has
// a wrong answer that is silently wrong (a mislabelled history entry, a revert stored as a copy)
// rather than visibly broken.

const props = defineProps<{ agentKind: string | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useToast()
const prompts = useAgentPromptsStore()
const agentSettings = useAgentSettingsStore()

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
 * Only a CANDIDATE: `saveIntent` drops it unless the draft still matches that revision's text,
 * so editing after a restore cannot mislabel the entry the next reader tries to trace.
 */
const restoredFrom = ref<number | undefined>(undefined)
/** Whether the built-in is shown beside the editor for comparison. */
const showBuiltin = ref(false)
/** Whether the non-editable text the platform appends is expanded. */
const showDirectives = ref(false)

watch(
  () => props.agentKind,
  async (kind) => {
    if (!kind) {
      prompts.reset()
      return
    }
    showBuiltin.value = false
    showDirectives.value = false
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

/**
 * The workspace-wide output-token ceiling for this kind — the same per-agent-kind scope this
 * editor already owns for the prompt, which is why it lives here rather than in a settings screen
 * of its own. A pipeline step may still pin its own budget over it.
 *
 * Saved on its own, immediately: unlike the prompt (whose save appends a revision and wants an
 * explicit commit) this is one scalar with no history, so a separate Save button would only invite
 * someone to type a number, close the modal and wonder why nothing changed.
 */
const budget = computed(() =>
  props.agentKind ? agentSettings.maxOutputTokensFor(props.agentKind) : undefined,
)

async function saveBudget(value: number | null) {
  const kind = props.agentKind
  if (!kind) return
  try {
    await agentSettings.setMaxOutputTokens(kind, value)
  } catch {
    toast.add({ title: t('agentPrompt.toast.budgetFailed'), color: 'error' })
  }
}

/** The live prompt, so "no change" can be reported instead of appending an identical revision. */
const dirty = computed(() => isDirty(draft.value, detail.value))
/** Nothing to revert to when the workspace is already running the shipped prompt. */
const canRevert = computed(() => detail.value?.customized === true)
/** What the platform appends to whatever is saved. Empty ⇒ the panel is not offered at all. */
const directives = computed(() => detail.value?.appendedText ?? '')

function pick(revision: AgentPromptRevision) {
  draft.value = draftForRevision(revision, detail.value)
  restoredFrom.value = revision.revision
}

function useBuiltin() {
  draft.value = detail.value?.builtinText ?? ''
  restoredFrom.value = undefined
}

async function save() {
  const kind = props.agentKind
  if (!kind) return
  const intent = saveIntent(draft.value, detail.value, restoredFrom.value)
  try {
    const saved = await prompts.save(kind, intent.text, intent.restoredFrom)
    draft.value = saved?.effectiveText ?? draft.value
    restoredFrom.value = undefined
    toast.add({ title: t('agentPrompt.toast.saved'), color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    const conflict = isRevisionConflict(error)
    toast.add({
      title: conflict ? t('agentPrompt.toast.conflict') : t('agentPrompt.toast.saveFailed'),
      color: 'error',
    })
    // The server's view already replaced the store's on a conflict, so re-seed the textarea
    // from what actually landed rather than leaving the user editing a lost revision — and drop
    // the restore candidate with it, since it names a revision from the log we just replaced.
    if (conflict) {
      draft.value = prompts.detail?.effectiveText ?? draft.value
      restoredFrom.value = undefined
    }
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

        <!-- The workspace-wide output ceiling for this kind. Same per-agent-kind scope as the
             prompt below it; saves on change, since there is no revision log to commit to. -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[11px] text-slate-400">{{ t('pipeline.outputBudget.kindLabel') }}</span>
          <OutputBudgetInput
            class="w-32"
            :model-value="budget"
            :disabled="agentSettings.saving"
            @update:model-value="saveBudget"
          />
          <span class="text-[10px] text-slate-500">
            {{ t('pipeline.outputBudget.kindHint') }}
          </span>
        </div>

        <!-- What the platform appends is SHOWN, not described. A prose summary of it is copy
             that silently goes stale the moment a directive is added, and a user who does not
             know what is already there writes a prompt that fights it. -->
        <p v-if="directives" class="text-[11px] leading-relaxed text-slate-500">
          {{ t('agentPrompt.managedNotice') }}
          <UButton
            variant="link"
            size="xs"
            class="px-1 align-baseline"
            @click="showDirectives = !showDirectives"
          >
            {{ showDirectives ? t('agentPrompt.hideAppended') : t('agentPrompt.showAppended') }}
          </UButton>
        </p>
        <div
          v-if="directives && showDirectives"
          class="rounded-md border border-slate-800 bg-slate-950/60 p-2"
        >
          <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('agentPrompt.appendedHeading') }}
          </h4>
          <pre
            class="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300"
            >{{ directives.trim() }}</pre>
        </div>

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
