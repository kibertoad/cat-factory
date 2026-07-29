<script setup lang="ts">
// The planner's human gate, reviewed on the PLAN — the tracker window's plan-approval rail.
//
// The rail this replaces could approve or send back, but it judged nothing: the plan was a wall
// of structured sections above it, with no way to navigate a long one and no way to say WHICH
// part needed changing. So it renders the plan as the document it is — the engine puts a markdown
// rendering of the ingested plan on the gate's proposal (`renderInitiativePlanForReview`, via the
// `reviewableArtifactOutput` seam) — and gives it the same three tools the step reader gives the
// architect's prose: an outline to navigate by, click-to-comment on any block, and overall
// feedback. Everything here is shared with that reader rather than re-implemented:
// `useStepProse` for the outline/collapse/scroll-spy, `useProseComments` for the anchoring, and
// the global `.reader-prose` sheet for the presentation, so the two surfaces cannot drift.
//
// Deliberately NOT offered here: "approve with corrections". The plan was ingested into the
// `initiatives` entity before this gate was raised, so the document is a VIEW of committed state
// — an edit typed over it would reach nothing, and the engine refuses it outright
// (`outputIsRendered` → 422). Requesting changes is the route for a correction, which is why a
// comment is worth anchoring: it quotes the planner's own text back to it on the re-plan.
import { computed, ref, watch } from 'vue'
import type { StepApproval } from '~/types/execution'
import { useStepProse } from '~/composables/useStepProse'
import { useProseComments } from '~/composables/useProseComments'

const props = defineProps<{
  /** The parked gate: its `proposal` is the rendered plan document under review. */
  approval: StepApproval
  /** The run the gate belongs to, for the approve / request-changes commands. */
  instanceId: string
  /** Whether the viewer may resolve runs at all (RBAC); false renders the actions disabled. */
  canExecute: boolean
}>()

const execution = useExecutionStore()
const { t } = useI18n()

/**
 * The plan document under review. Not named `document` — that shadows the global in a template
 * expression. Empty on a run planned before the engine rendered the plan onto the gate, which the
 * `noDocument` notice below states rather than passing the transcript summary off as the plan.
 */
const planDocument = computed(() => props.approval.proposal ?? '')

// The outline + collapse + scroll-spy, exactly as the step reader resolves them.
const scrollEl = ref<HTMLElement | null>(null)
const prose = useStepProse(() => planDocument.value)
const { outline, tocSections, hasOutput, collapsed, activeId, sectionEls, toggle, goTo, onScroll } =
  prose

// Wire the reader's own scroll container into the shared scroll-spy (the step reader binds the
// overlay's; here the document scrolls inside this component).
watch(scrollEl, (el) => {
  prose.scrollEl.value = el
})

/** Per-block comment drafts over the plan, anchored to its source lines. */
const {
  comments: planComments,
  wireComments,
  draftTarget,
  draftBody,
  onProseClick,
  addDraftComment,
  cancelDraft,
  removeComment,
  reset: resetComments,
} = useProseComments({
  output: () => planDocument.value,
  root: () => scrollEl.value,
  enabled: () => true,
})

const feedback = ref('')
const submitting = ref(false)

/** Changes can only be requested with something to act on — an empty send would re-plan blind. */
const canRequestChanges = computed(() => !!feedback.value.trim() || planComments.value.length > 0)

/** A fresh gate (a re-plan parked again) drops the drafts rather than carrying them over. */
watch(
  () => props.approval.id,
  () => {
    resetComments()
    feedback.value = ''
    prose.reset()
  },
)

/**
 * Accept the plan: the run advances to the committer, which persists it and arms the execution
 * loop. The window stays open — the rail disappears with the approval (live) and the tracker is
 * where the plan then executes.
 */
async function approve() {
  if (submitting.value || !props.canExecute) return
  submitting.value = true
  try {
    await execution.approveStep(props.instanceId, props.approval.id)
  } finally {
    submitting.value = false
  }
}

/** Send the plan back: the planner re-plans from the feedback + the anchored comments. */
async function requestChanges() {
  if (submitting.value || !canRequestChanges.value || !props.canExecute) return
  submitting.value = true
  try {
    const ok = await execution.requestStepChanges(props.instanceId, props.approval.id, {
      feedback: feedback.value.trim() || undefined,
      comments: wireComments.value,
    })
    if (ok) {
      feedback.value = ''
      resetComments()
    }
  } finally {
    submitting.value = false
  }
}

const disabledTitle = computed(() => (props.canExecute ? undefined : t('access.noRunExecute')))
</script>

<template>
  <section
    class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10"
    data-testid="initiative-plan-review"
  >
    <header class="flex items-start gap-2.5 px-3.5 pt-3.5">
      <UIcon name="i-lucide-clipboard-check" class="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div class="min-w-0 flex-1">
        <h3 class="text-[13px] font-semibold text-amber-200">
          {{ t('initiative.planReview.title') }}
        </h3>
        <p class="mt-0.5 text-[12px] leading-relaxed text-amber-100/80">
          {{ t('initiative.planReview.body') }}
        </p>
      </div>
    </header>

    <!-- The plan document. A run planned before the engine rendered it onto the gate carries only
         the planner's transcript summary, so say so rather than showing a stray sentence as if it
         were the plan — the structured sections below are still the plan in that case. -->
    <div v-if="hasOutput" class="mt-3 flex min-h-0 gap-3 px-3.5">
      <!-- Outline: the navigation the rail had none of. Inline rather than a full sidebar — the
           tracker window already spends its end-side column on run metadata. -->
      <nav
        v-if="outline.hasToc"
        data-testid="initiative-plan-toc"
        class="hidden max-h-80 w-48 shrink-0 space-y-0.5 overflow-y-auto border-e border-amber-500/20 pe-2 md:block"
      >
        <button
          v-for="s in tocSections"
          :key="s.id"
          class="block w-full truncate rounded px-1.5 py-1 text-start text-[12px] transition"
          :class="
            activeId === s.id
              ? 'bg-amber-500/20 font-medium text-amber-100'
              : 'text-amber-200/60 hover:bg-amber-500/10 hover:text-amber-100'
          "
          :style="{ paddingLeft: `${(s.depth - outline.minDepth) * 0.7 + 0.4}rem` }"
          :title="s.title"
          @click="goTo(s.id)"
        >
          {{ s.title }}
        </button>
      </nav>

      <div
        ref="scrollEl"
        data-testid="initiative-plan-document"
        class="max-h-80 min-w-0 flex-1 overflow-y-auto rounded border border-amber-500/20 bg-slate-950/40 p-3"
        @scroll="onScroll"
      >
        <section
          v-for="s in outline.sections"
          :id="s.id"
          :key="s.id"
          :ref="(el) => (sectionEls[s.id] = el as HTMLElement | null)"
          class="scroll-mt-2"
        >
          <button
            v-if="s.depth > 0"
            class="group flex w-full items-center gap-1.5 rounded py-0.5 text-start transition hover:text-white"
            @click="toggle(s.id)"
          >
            <UIcon
              name="i-lucide-chevron-right"
              class="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform"
              :class="collapsed[s.id] ? '' : 'rotate-90'"
            />
            <span
              class="font-semibold text-slate-100"
              :class="s.depth <= 1 ? 'text-sm' : 'text-[13px]'"
              v-html="s.titleHtml"
            />
          </button>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-show="!collapsed[s.id]"
            class="reader-prose review-mode mt-0.5 text-[12px] leading-relaxed text-slate-300"
            :class="s.depth > 0 ? 'ps-5' : ''"
            @click="onProseClick"
            v-html="s.bodyHtml"
          />
        </section>
      </div>
    </div>
    <p v-else class="mt-2 px-3.5 text-[12px] text-amber-100/70">
      {{ t('initiative.planReview.noDocument') }}
    </p>

    <!-- Comment composer for the block just clicked, then the anchored comments so far. -->
    <div v-if="draftTarget" class="mt-3 px-3.5" data-testid="initiative-plan-composer">
      <div class="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-2.5">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-indigo-300">
          {{ t('panels.stepDetail.commentingOn') }}
        </div>
        <pre
          class="mb-2 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-1.5 text-[11px] text-slate-300"
          >{{ draftTarget.quotedSource }}</pre>
        <UTextarea
          v-model="draftBody"
          data-testid="initiative-plan-comment-body"
          :rows="2"
          autoresize
          size="sm"
          class="w-full"
          :placeholder="t('panels.stepDetail.commentPlaceholder')"
        />
        <div class="mt-2 flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" size="xs" @click="cancelDraft">
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            size="xs"
            data-testid="initiative-plan-comment-add"
            :disabled="!draftBody.trim()"
            @click="addDraftComment"
          >
            {{ t('panels.stepDetail.addComment') }}
          </UButton>
        </div>
      </div>
    </div>

    <ul v-if="planComments.length" class="mt-3 space-y-2 px-3.5">
      <li
        v-for="(c, idx) in planComments"
        :key="idx"
        data-testid="initiative-plan-comment"
        class="rounded-lg border border-slate-700 bg-slate-900/50 p-2.5"
      >
        <div class="mb-1 flex items-start justify-between gap-2">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('panels.stepDetail.commentN', { number: idx + 1 }) }}
          </div>
          <button
            class="text-slate-500 transition hover:text-rose-400"
            :title="t('panels.stepDetail.removeComment')"
            @click="removeComment(idx)"
          >
            <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
          </button>
        </div>
        <pre
          class="mb-1 max-h-16 overflow-auto whitespace-pre-wrap rounded bg-slate-950/50 p-1.5 text-[10px] text-slate-400"
          >{{ c.quotedSource }}</pre>
        <p class="text-[12px] text-slate-200">{{ c.body }}</p>
      </li>
    </ul>

    <!-- Overall feedback + the two actions. Feedback stays visible rather than hiding behind a
         "request changes" step: with per-block comments in play the human is already composing a
         review, and a hidden field reads as "there is nothing more to say". -->
    <div class="mt-3 px-3.5 pb-3.5">
      <UTextarea
        v-model="feedback"
        data-testid="initiative-plan-feedback"
        :rows="2"
        autoresize
        size="sm"
        class="w-full"
        :placeholder="t('initiative.planReview.feedbackPlaceholder')"
      />
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-check"
          data-testid="initiative-plan-approve"
          :loading="submitting"
          :disabled="!canExecute"
          :title="disabledTitle"
          @click="approve"
        >
          {{ t('initiative.planReview.approve') }}
        </UButton>
        <UButton
          color="warning"
          variant="soft"
          size="xs"
          icon="i-lucide-rotate-ccw"
          data-testid="initiative-plan-send-back"
          :loading="submitting"
          :disabled="!canRequestChanges || !canExecute"
          :title="
            canExecute && !canRequestChanges
              ? t('initiative.planReview.needsFeedback')
              : disabledTitle
          "
          @click="requestChanges"
        >
          {{ t('initiative.planReview.sendBack') }}
        </UButton>
        <p v-if="hasOutput" class="text-[10px] text-amber-100/60">
          {{ t('initiative.planReview.commentHint') }}
        </p>
      </div>
    </div>
  </section>
</template>
