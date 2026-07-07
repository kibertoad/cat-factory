<script setup lang="ts">
// Shared "clarification item" — the per-prompt answer surface reused by the initiative-planning
// window and (incrementally) the requirements-review window, so the two ask/answer/dismiss/recommend
// UIs are ONE component rather than parallel clones. See docs/initiatives/clarification-items.md.
//
// It renders a prompt, an answer textarea, and the common actions (Not relevant / Recommend), plus
// a dismissed→reopen state and an optional inline AI suggestion with "Use this answer". Window
// -specific extras (severity/category badges, a window's own recommendation section) ride the
// `badges` / `actions` slots; the recommend button only EMITS, so each window wires its own
// recommend mechanism. `dismissed`/`requested` hide the textarea (nothing to answer right now).
const props = defineProps<{
  /** The question / finding headline. */
  prompt: string
  /** Optional longer prose under the prompt (e.g. a requirements finding's detail). */
  detail?: string
  /** The editable answer draft (v-model). Undefined is treated as empty. */
  answer?: string
  /** The human marked this not-relevant → show a chip + Reopen instead of the answer box. */
  dismissed?: boolean
  /** A recommendation is being generated for this item → hide the box, show a working chip. */
  requested?: boolean
  /** An AI-suggested answer to offer inline, or null/undefined for none. */
  recommendation?: string | null
  /** A recommend request is in flight for THIS item (button spinner). */
  recommending?: boolean
  /** Freeze all inputs/actions (settled / background cycle running). */
  disabled?: boolean
  /** Placeholder for the answer box; defaults to the shared clarification placeholder. */
  answerPlaceholder?: string
  /** Show the Recommend action (needs a wired model). Default true. */
  canRecommend?: boolean
}>()

const emit = defineEmits<{
  'update:answer': [value: string]
  persist: []
  dismiss: []
  reopen: []
  recommend: []
  useRecommendation: []
}>()

const { t } = useI18n()

const draft = computed({
  get: () => props.answer ?? '',
  set: (value: string) => emit('update:answer', value),
})
</script>

<template>
  <div
    class="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
    data-testid="clarification-item"
  >
    <div class="flex items-start justify-between gap-2">
      <p class="text-[13px] font-medium text-slate-200">{{ prompt }}</p>
      <slot name="badges" />
    </div>
    <p v-if="detail" class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-400">
      {{ detail }}
    </p>

    <!-- dismissed: a "not relevant" chip + reopen -->
    <div v-if="dismissed" class="mt-2 flex items-center justify-between gap-2">
      <span class="inline-flex items-center gap-1 text-[11px] text-slate-500">
        <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />{{ t('clarification.dismissed') }}
      </span>
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-rotate-ccw"
        data-testid="clarification-reopen"
        :disabled="disabled"
        @click="emit('reopen')"
      >
        {{ t('clarification.reopen') }}
      </UButton>
    </div>

    <!-- a recommendation is being requested/generated: a working chip, no answer box -->
    <div
      v-else-if="requested"
      class="mt-2 inline-flex items-center gap-1 text-[11px] text-indigo-300"
      data-testid="clarification-requested"
    >
      <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin" />
      {{ t('clarification.generating') }}
    </div>

    <template v-else>
      <UTextarea
        v-model="draft"
        :rows="2"
        autoresize
        :disabled="disabled"
        :placeholder="answerPlaceholder ?? t('clarification.answerPlaceholder')"
        class="mt-2 w-full"
        data-testid="clarification-answer"
        @blur="emit('persist')"
      />
      <div class="mt-2 flex flex-wrap items-center gap-1">
        <UButton
          size="xs"
          variant="soft"
          color="neutral"
          icon="i-lucide-x"
          data-testid="clarification-dismiss"
          :disabled="disabled"
          @click="emit('dismiss')"
        >
          {{ t('clarification.notRelevant') }}
        </UButton>
        <UButton
          v-if="canRecommend !== false"
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-wand-2"
          data-testid="clarification-recommend"
          :loading="recommending"
          :disabled="disabled || recommending"
          @click="emit('recommend')"
        >
          {{ t('clarification.recommend') }}
        </UButton>
        <slot name="actions" />
      </div>

      <!-- inline AI suggestion + "use this answer" -->
      <div
        v-if="recommendation"
        class="mt-2 rounded-md border border-indigo-800/50 bg-indigo-950/30 p-2"
        data-testid="clarification-recommendation"
      >
        <div
          class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-indigo-300"
        >
          <UIcon name="i-lucide-wand-2" class="h-3 w-3" />{{ t('clarification.suggestion') }}
        </div>
        <p class="whitespace-pre-wrap text-[12px] text-slate-200">{{ recommendation }}</p>
        <UButton
          class="mt-1.5"
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-check"
          data-testid="clarification-use-recommendation"
          :disabled="disabled"
          @click="emit('useRecommendation')"
        >
          {{ t('clarification.useSuggestion') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
