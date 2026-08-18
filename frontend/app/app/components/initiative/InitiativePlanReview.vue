<script setup lang="ts">
// The planner's human gate, reviewed on the PLAN — the surface the tracker window hands its WHOLE
// body to while a rendered plan is parked.
//
// The rail this replaces could approve or send back, but it judged nothing: the plan was a wall of
// structured sections above it, with no way to navigate a long one and no way to say WHICH part
// needed changing. So it renders the plan as the document it is — the engine puts a markdown
// rendering of the INGESTED plan on the gate's proposal (`renderInitiativePlanForReview`, authored
// by the planner's step resolver, the only thing that knows what ingest committed) — and gives it
// the same three tools the step reader gives the architect's prose: an outline to navigate by,
// click-to-comment on any block, and overall feedback.
//
// The LAYOUT is the step reader's too, and for the same reasons (`AgentStepDetail.vue`). The first
// cut of this surface was a card INSIDE the tracker's scrolling column: outline and document split
// that column's width between them, the document capped at a 20rem window, and the tracker's own
// goal / phases / policy / logs sections — the very same plan, since the render reads the ingested
// entity — repeated underneath. Reviewers scrolled a letterbox while a second copy of what they
// were reading sat below it. Now the outline is a sidebar OUTSIDE the document, the document takes
// the full height of the window, the commands sit in an end-side rail, and the duplicate is gone
// because the window renders this INSTEAD of the tracker while the gate is parked (the tracker's
// remaining panels — PR links, curation, checkpoints, follow-ups — are all execution-time state
// that cannot exist yet at plan time).
//
// Everything under the layout is shared with that reader rather than re-implemented: `useStepProse`
// for the outline/collapse/scroll-spy, `useProseComments` for the anchoring, `InitiativePlanDecision`
// for the two commands, and the global `.reader-prose` sheet for the presentation — so the surfaces
// cannot drift.
import { onUnmounted, ref, watch } from 'vue'
import type { StepApproval } from '~/types/execution'
import { useStepProse } from '~/composables/useStepProse'
import { useProseComments } from '~/composables/useProseComments'
import InitiativePlanDecision from '~/components/initiative/InitiativePlanDecision.vue'

const props = defineProps<{
  /** The parked gate under review. */
  approval: StepApproval
  /** The run the gate belongs to, for the approve / request-changes commands. */
  instanceId: string
  /** Whether the viewer may resolve runs at all (RBAC); false renders the actions disabled. */
  canExecute: boolean
  /**
   * The rendered plan under review, resolved by the host through `planReviewDocument` — the same
   * value that decided to mount THIS surface rather than the notice, so it is non-empty here.
   */
  planDocument: string
}>()

const { t } = useI18n()

// The outline + collapse + scroll-spy, exactly as the step reader resolves them — minus its lead
// anchor: the reader renders a details card ahead of the prose, while here the run details sit in
// the sidebar (never scrolled past), and the spy stops at the first anchor it cannot measure.
const prose = useStepProse(() => props.planDocument, { leadAnchorId: null })
const {
  outline,
  tocSections,
  collapsed,
  activeId,
  // The scroll container, bound straight through so the shared scroll-spy and the comment-highlight
  // sync read the same element the template scrolls.
  scrollEl,
  sectionEls,
  toggle,
  setAll,
  allCollapsed,
  goTo,
  onScroll,
} = prose

/**
 * Per-block comment drafts over the plan, anchored to its source lines. Commenting follows the same
 * RBAC gate as the commands: a viewer who cannot resolve the run cannot send the comments anywhere,
 * so offering the composer would only invite work the Send-back button then refuses.
 */
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
  output: () => props.planDocument,
  root: () => scrollEl.value,
  enabled: () => props.canExecute,
})

/** A fresh gate (a re-plan parked again) reviews the new plan clean, from the top. */
watch(
  () => props.approval.id,
  () => {
    resetComments()
    prose.reset()
  },
)

/**
 * Whether this review holds work that is not on the server yet, relayed to the window that owns
 * closing (UX-79). Three things count and all three are lost on a stray Escape: anchored comments
 * already placed, a comment being typed, and the decision's overall feedback. They are reported
 * rather than auto-sent, because sending them RESOLVES the gate and re-plans the initiative.
 */
const emit = defineEmits<{ 'update:dirty': [boolean] }>()
const decisionDirty = ref(false)
watch(
  () => decisionDirty.value || planComments.value.length > 0 || draftBody.value.trim().length > 0,
  (dirty) => emit('update:dirty', dirty),
)
onUnmounted(() => emit('update:dirty', false))

/** Whether the sidebar's run-details stack is expanded (it is, until a reviewer wants the outline). */
const runDetailsOpen = ref(true)

const { copy } = useCopyToClipboard()
async function copyPlan() {
  await copy(props.planDocument)
}
</script>

<template>
  <!-- The gate's id is published because a send-back is only observable through it. The rail is
       torn down and rebuilt for the re-plan's NEW gate, but the gap between the two is not a state
       the SPA is guaranteed to see: the send-back's own `ws.refresh()` races the re-plan, which
       with a fast planner can park again first, so the rail goes straight from one gate to the
       next. Asserting the absence was a race; asserting WHICH gate is on screen is the invariant
       underneath it. Read by `initiative-plan-review.spec.ts`. -->
  <div
    class="flex min-h-0 flex-1 flex-col lg:flex-row"
    data-testid="initiative-plan-review"
    :data-approval-id="approval.id"
  >
    <!-- Navigation column: the outline OUTSIDE the document rather than splitting its width — a
         sidebar of the window, as the step reader's is. Narrower than the reader's (`w-52` against
         its `w-72`) and held back to `lg` rather than its `md`, because this is a THREE-column
         layout: at 768px the document would be left ~240px between the outline and the review rail,
         which reads worse than no outline at all. Below `lg` the whole column goes; the document and
         the commands are what a narrow screen needs.

         Its presence tracks its two contents INDEPENDENTLY rather than the outline alone. Gating the
         run details on `outline.hasToc` would make whether this window still reports its model / run
         id / token spend depend on whether the plan renderer happened to emit a heading — a fact
         owned by `renderInitiativePlanForReview`, in another package, with nothing pinning it. The
         step reader keeps the same document-level affordances out of its own `hasToc` guard for that
         reason, in a main-column header this surface does not have. -->
    <aside
      v-if="outline.hasToc || $slots['run-details']"
      class="hidden w-52 shrink-0 flex-col border-e border-slate-800 bg-slate-900/60 lg:flex"
    >
      <div class="flex items-center gap-0.5 border-b border-slate-800 px-3 py-2">
        <span
          v-if="outline.hasToc"
          class="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500"
        >
          {{ t('panels.stepDetail.contents') }}
        </span>
        <span v-else class="flex-1" />
        <!-- Collapse-all tracks the outline: with no headings the only section is the untitled
             preamble, which renders no toggle of its own, so collapsing it would hide the whole
             plan with nothing on screen to bring it back. Copying it does not — that is about the
             document, which exists either way. -->
        <UButton
          v-if="outline.hasToc"
          :icon="allCollapsed ? 'i-lucide-unfold-vertical' : 'i-lucide-fold-vertical'"
          color="neutral"
          variant="ghost"
          size="xs"
          :title="
            allCollapsed ? t('panels.stepDetail.expandAll') : t('panels.stepDetail.collapseAll')
          "
          @click="setAll(!allCollapsed)"
        />
        <UButton
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          size="xs"
          :title="t('panels.stepDetail.copyRawOutput')"
          @click="copyPlan"
        />
      </div>
      <nav
        v-if="outline.hasToc"
        data-testid="initiative-plan-toc"
        :aria-label="t('panels.stepDetail.contents')"
        class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2"
      >
        <button
          v-for="s in tocSections"
          :key="s.id"
          class="block w-full truncate rounded-md px-2 py-1 text-start text-[12px] transition"
          :class="
            activeId === s.id
              ? 'bg-amber-500/15 font-medium text-amber-100'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
          "
          :style="{ paddingLeft: `${(s.depth - outline.minDepth) * 0.7 + 0.5}rem` }"
          :title="s.title"
          @click="goTo(s.id)"
        >
          {{ s.title }}
        </button>
      </nav>
      <!-- Run details (the model, the run id, the token telemetry). Filled by the host, which
           already resolves the bundle through `useResultViewRunMeta`; it keeps its home in a
           sidebar here rather than disappearing for the duration of the review. Open, but
           collapsible: it is a stack of seven labelled fields, and a reviewer navigating a long
           plan should be able to give the outline the whole column. With no outline above it there
           is no column to give back, so it takes the space instead of leaving 55% of it empty. -->
      <div
        v-if="$slots['run-details']"
        class="flex flex-col"
        :class="
          outline.hasToc ? 'max-h-[45%] shrink-0 border-t border-slate-800' : 'min-h-0 flex-1'
        "
      >
        <button
          type="button"
          data-testid="initiative-plan-run-meta-toggle"
          class="flex shrink-0 items-center gap-1.5 px-3 py-2 text-start transition hover:bg-slate-800/40"
          :aria-expanded="runDetailsOpen"
          @click="runDetailsOpen = !runDetailsOpen"
        >
          <span class="flex-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('panels.stepDetail.details') }}
          </span>
          <UIcon
            :name="runDetailsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
            class="h-3.5 w-3.5 shrink-0 text-slate-500"
          />
        </button>
        <div
          v-if="runDetailsOpen"
          data-testid="initiative-plan-run-meta"
          class="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        >
          <slot name="run-details" />
        </div>
      </div>
    </aside>

    <!-- The plan itself, with the full height of the window to be read in. -->
    <div
      ref="scrollEl"
      data-testid="initiative-plan-document"
      class="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4"
      @scroll="onScroll"
    >
      <!-- The reading measure, which the shell's `full` width made load-bearing: this column used
           to be ~490px at every size that rendered it (a fixed outline and a fixed rail out of a
           `5xl` shell), so a cap was dead markup and the comment here said so. On a window that now
           spans the viewport it is the only thing between the plan and 200-character lines, and it
           is the step reader's own measure (`AgentStepDetail`, `mx-auto max-w-3xl` over the same
           13px `.reader-prose`) rather than a second opinion about how wide prose should be. The
           leftover width is the document's margins; the LAYOUT is what the extra space bought —
           outline and rail no longer competing with the plan for one 5xl card. -->
      <div class="mx-auto w-full max-w-3xl">
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
            :aria-expanded="!collapsed[s.id]"
            @click="toggle(s.id)"
          >
            <UIcon
              name="i-lucide-chevron-right"
              class="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform group-hover:text-slate-300"
              :class="collapsed[s.id] ? '' : 'rotate-90'"
            />
            <span
              class="font-semibold text-slate-100"
              :class="s.depth <= 1 ? 'text-base' : s.depth === 2 ? 'text-sm' : 'text-[13px]'"
              v-html="s.titleHtml"
            />
          </button>
          <!-- `review-mode` carries the click-to-comment affordance, so it tracks the same RBAC
               gate the composer does — a viewer gets the document, not hover targets that lead
               nowhere. -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-show="!collapsed[s.id]"
            class="reader-prose mt-0.5 text-[13px] leading-relaxed text-slate-300"
            :class="[s.depth > 0 ? 'ps-5' : '', canExecute ? 'review-mode' : '']"
            @click="onProseClick"
            v-html="s.bodyHtml"
          />
        </section>
      </div>
    </div>

    <!-- Review rail: what the human is being asked, the anchored comments so far, and the two
         commands — the step reader's end-side rail. Below `lg` it drops under the document, capped
         so a long comment list can't crowd the plan off the screen. -->
    <aside
      :aria-label="t('initiative.planReview.title')"
      class="flex max-h-[55%] w-full shrink-0 flex-col border-t border-slate-800 bg-slate-900/60 lg:max-h-none lg:w-72 lg:border-s lg:border-t-0"
    >
      <div class="border-b border-slate-800 px-4 py-3">
        <!-- A HEADING, not a styled div: this rail is what the window is now for, so the surface
             that asks the human for a decision has to be reachable as one. -->
        <h3
          class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-400"
        >
          <UIcon name="i-lucide-clipboard-check" class="h-3.5 w-3.5 shrink-0" />
          {{ t('initiative.planReview.title') }}
        </h3>
        <p class="mt-1 text-[12px] leading-relaxed text-slate-400">
          {{ t('initiative.planReview.body') }}
        </p>
      </div>

      <div class="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        <!-- Composer for the block just clicked. -->
        <div
          v-if="draftTarget"
          data-testid="initiative-plan-composer"
          class="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-2.5"
        >
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

        <!-- The anchored comments so far. -->
        <div
          v-for="(c, idx) in planComments"
          :key="idx"
          data-testid="initiative-plan-comment"
          class="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5"
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
        </div>

        <!-- Only worth saying where clicking a block does something (the RBAC to act on it) and
             where nothing has been said yet. -->
        <p
          v-if="canExecute && !draftTarget && !planComments.length"
          class="text-[11px] leading-relaxed text-slate-400"
        >
          {{ t('initiative.planReview.commentHint') }}
        </p>
      </div>

      <!-- Overall feedback + the two commands. Feedback stays visible rather than hiding behind a
           "request changes" step: with per-block comments in play the human is already composing a
           review, and a hidden field reads as "there is nothing more to say". -->
      <InitiativePlanDecision
        class="border-t border-slate-800 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        :approval-id="approval.id"
        :instance-id="instanceId"
        :can-execute="canExecute"
        :comments="wireComments"
        @sent="resetComments"
        @update:dirty="decisionDirty = $event"
      />
    </aside>
  </div>
</template>
