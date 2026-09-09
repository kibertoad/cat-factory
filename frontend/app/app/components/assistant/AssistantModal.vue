<script setup lang="ts">
// The in-app assistant: type what you want done, and the platform does it.
//
// The whole surface is one prompt box and one OUTCOME, and the outcome is rendered from the
// turn's DATA rather than from anything a model wrote. That is not a stylistic choice: the
// backend deliberately puts no model prose on the wire (a turn answers with the action it
// performed, or a machine-readable reason it could not), so every sentence here comes out of the
// i18n catalog and reads the same in every locale.
//
// Two of the three outcomes are not failures and must not look like one:
//   - `needs_input` is a QUESTION. Where the platform had candidates (two services matching the
//     name, a repository under a different owner, two trackers that both read the reference) each
//     is a chip that ANSWERS it: one click re-runs the same action with that value in the field
//     the platform named, with no model call and nothing retyped.
//   - `declined` means nothing in the catalog matches. It renders the catalog, because "I can't
//     do that" without saying what it CAN do is the least useful answer this surface can give.
// Everything that IS a failure of a TURN (the budget spent, an unconfigured tracker, an issue
// already filed) arrives as an error and goes through the shared toast funnel with its reason, its
// detail and its request id, the same path a failed button press takes. What the CAPABILITY read
// finds is not on that path: an unwired deployment, an empty catalog and a read that failed are
// each a panel here, in place of the box, because that is where the person is looking and where
// the retry belongs.
import type { AssistantActionId, AssistantOutcome } from '~/types/domain'
import { answerFor, assistantSurface, revealTarget, submitGate } from './AssistantModal.logic'

const { t } = useI18n()
const ui = useUiStore()
const assistant = useAssistantStore()
const { present } = usePipelineErrorToast()

const open = computed({
  get: () => ui.assistantOpen,
  set: (value: boolean) => (value ? ui.openAssistant() : ui.closeAssistant()),
})

const prompt = ref('')

/** The outcome of the last turn, or null before the first one / after the prompt is edited. */
const outcome = computed<AssistantOutcome | null>(() => assistant.turn?.outcome ?? null)

/** The example prompts offered as a starting point, one per action this deployment can perform. */
const examples = computed(() =>
  assistant.actions.map((actionId: AssistantActionId) => ({
    actionId,
    label: t(`assistant.actions.${actionId}.label`),
    example: t(`assistant.actions.${actionId}.example`),
  })),
)

/**
 * Read the capability on every open, INCLUDING the render the modal mounts on.
 *
 * `onModalOpen` rather than a bare `watch` because the page mounts this component only while the
 * open flag is set (`<AssistantModal v-if="ui.assistantOpen">`), so `open` is already true at
 * setup and a change-only watcher never fires at all. Re-reading on each open is what lets a
 * provider wired while the tab is open be picked up with no reload; the previous answer is kept
 * while that re-read is in flight, so a second open shows the box rather than a spinner.
 */
onModalOpen(open, () => {
  assistant.reset()
  void assistant.loadCapability()
})

/**
 * What the modal shows: the box, or the reason there is none.
 *
 * A read still in flight shows the BOX, disabled, rather than a spinner in its place: this modal is
 * opened from the sidebar and from the command palette, so the hands are already on the keyboard,
 * and a textarea that only mounts once the read lands would swallow whatever was typed in between.
 */
const surface = computed(() => assistantSurface(assistant.capabilityRead, assistant.capability))

/** Whether the request can be sent. */
const gate = computed(() =>
  submitGate({
    read: assistant.capabilityRead,
    capability: assistant.capability,
    prompt: prompt.value,
    running: assistant.running,
  }),
)

/**
 * Why Run is disabled, where that is not already on screen.
 *
 * An empty box is answered by its own placeholder and the examples under it, and a turn in flight
 * by the button's spinner. Two are stated: a refused LENGTH, because a person who pasted a page has
 * no way to see that it is 143 characters too long, and a capability read still in flight, because
 * a button that will start working on its own in a moment otherwise reads as one that is broken.
 * The line is a live region tied to the button, so the reason reaches a reader that cannot see it.
 */
const submitReason = computed<string | null>(() => {
  const state = gate.value
  if (state.state === 'too_long') {
    return t('assistant.tooLong', { length: state.length, limit: state.limit })
  }
  return state.state === 'checking' ? t('assistant.reading') : null
})

/** Editing the prompt clears the previous answer, so an outcome never sits under a new question. */
watch(prompt, () => {
  if (outcome.value) assistant.reset()
})

/** Re-read the capability, from the retry a failed read offers. */
function retry(): void {
  void assistant.loadCapability()
}

async function submit(): Promise<void> {
  if (gate.value.state !== 'ready') return
  try {
    await assistant.run(prompt.value.trim())
  } catch (error) {
    present(error, 'assistant.title')
  }
}

/** Put an example in the box, ready to edit, never submitted for the person. */
function useExample(example: string): void {
  prompt.value = example
  assistant.reset()
}

/**
 * Answer a clarification with one of the candidates the platform offered.
 *
 * Submitted as DATA, not as more prose: the turn re-runs the action it was already heading for
 * with the chosen value in the field it named. Appending the candidate to the sentence and asking
 * the model again is what this replaces, and it could not settle the question (see `answerFor`).
 * The prompt box is left exactly as the person typed it, because the request has not changed.
 */
async function useCandidate(
  question: Extract<AssistantOutcome, { status: 'needs_input' }>,
  candidate: string,
): Promise<void> {
  if (assistant.running) return
  try {
    await assistant.answer(answerFor(question, candidate))
  } catch (error) {
    present(error, 'assistant.title')
  }
}

/** Select what a performed turn produced, and close, so the board shows it straight away. */
function reveal(blockId: string): void {
  ui.select(blockId)
  ui.focus(blockId)
  ui.closeAssistant()
}
</script>

<template>
  <UModal v-model:open="open" :title="t('assistant.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-slate-400">{{ t('assistant.intro') }}</p>

        <!-- The read FAILED: this deployment may well have a model, and nobody can tell from here.
             So it offers the read again instead of explaining a configuration that may be fine. -->
        <div
          v-if="surface === 'unreadable'"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
          data-testid="assistant-unreadable"
        >
          <UIcon name="i-lucide-unplug" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div class="space-y-2">
            <p>{{ t('assistant.unreadable') }}</p>
            <UButton
              size="xs"
              variant="soft"
              icon="i-lucide-refresh-cw"
              data-testid="assistant-retry"
              @click="retry"
            >
              {{ t('common.retry') }}
            </UButton>
          </div>
        </div>

        <!-- No model wired: say so, rather than offering a box whose every submit would 503. -->
        <div
          v-else-if="surface === 'unwired'"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
          data-testid="assistant-unwired"
        >
          <UIcon name="i-lucide-plug" class="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <span>{{ t('assistant.unavailable') }}</span>
        </div>

        <!-- A model, and nothing for it to do: a different deployment fault with a different fix,
             and every submit against it would be refused with `assistant_no_actions`. -->
        <div
          v-else-if="surface === 'no_actions'"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
          data-testid="assistant-no-actions"
        >
          <UIcon name="i-lucide-list-x" class="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <span>{{ t('assistant.noActions') }}</span>
        </div>

        <template v-else>
          <!-- Full width and roomy: a request is a sentence or three, and the box it is typed in
               is the whole surface. `autoresize` grows it with the text up to `maxrows`, after
               which it scrolls rather than pushing the examples and the outcome off the modal. -->
          <UTextarea
            v-model="prompt"
            :rows="6"
            autoresize
            :maxrows="14"
            autofocus
            class="w-full"
            :disabled="assistant.running"
            :placeholder="t('assistant.placeholder')"
            data-testid="assistant-prompt"
            @keydown.enter.meta.prevent="submit"
            @keydown.enter.ctrl.prevent="submit"
          />

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              color="primary"
              icon="i-lucide-sparkles"
              :loading="assistant.running"
              :disabled="gate.state !== 'ready'"
              aria-describedby="assistant-submit-reason"
              data-testid="assistant-submit"
              @click="submit"
            >
              {{ t('assistant.submit') }}
            </UButton>
            <!-- The stated reason takes the keyboard hint's place while it applies. ONE element
                 for both, named by the button it explains and present from the first render: a
                 disabled button is out of the tab order and announces nothing, so a reason that
                 only appears in a span nothing points at leaves the one reader who cannot see it
                 with a Run that does nothing and no reason given. It announces only while it is
                 carrying a REASON; the keyboard hint is standing information, not news. -->
            <span
              id="assistant-submit-reason"
              role="status"
              :aria-live="submitReason ? 'polite' : 'off'"
              class="flex items-center gap-1 text-xs"
              :class="submitReason ? 'text-amber-400' : 'text-slate-500'"
              data-testid="assistant-submit-status"
            >
              <UIcon
                v-if="gate.state === 'checking'"
                name="i-lucide-loader-circle"
                class="h-3 w-3 shrink-0 animate-spin"
              />
              {{ submitReason ?? t('assistant.submitHint') }}
            </span>
          </div>

          <!-- What it can do, always visible: the catalog is the affordance. -->
          <div v-if="examples.length" class="space-y-2">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500">
              {{ t('assistant.examplesTitle') }}
            </p>
            <div class="flex flex-col gap-1">
              <button
                v-for="entry in examples"
                :key="entry.actionId"
                type="button"
                class="rounded-md px-2 py-1 text-left text-sm text-slate-300 hover:bg-slate-800"
                @click="useExample(entry.example)"
              >
                <span class="text-slate-400">{{ entry.label }}</span>
                <span class="block text-xs text-slate-500">“{{ entry.example }}”</span>
              </button>
            </div>
          </div>

          <!-- The outcome. Rendered from the turn's data; no model prose reaches this. -->
          <div
            v-if="outcome"
            class="rounded-md border border-slate-700 p-3 text-sm"
            data-testid="assistant-outcome"
          >
            <template v-if="outcome.status === 'performed'">
              <div class="flex items-start gap-2 text-slate-200">
                <UIcon name="i-lucide-check" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div class="space-y-2">
                  <p v-if="outcome.result.actionId === 'declare-service-dependency'">
                    {{
                      t(
                        outcome.result.created
                          ? 'assistant.done.dependencyDeclared'
                          : 'assistant.done.dependencyAlready',
                        {
                          consumer: outcome.result.consumer.title,
                          provider: outcome.result.provider.title,
                        },
                      )
                    }}
                  </p>
                  <p v-else-if="outcome.result.actionId === 'add-service-from-repo'">
                    {{
                      t(
                        outcome.result.created
                          ? 'assistant.done.serviceAdded'
                          : 'assistant.done.serviceMounted',
                        {
                          service: outcome.result.service.title,
                          repo: `${outcome.result.repo.owner}/${outcome.result.repo.name}`,
                        },
                      )
                    }}
                  </p>
                  <p v-else>
                    {{
                      t('assistant.done.taskCreated', {
                        task: outcome.result.task.title,
                        service: outcome.result.service.title,
                        issue: outcome.result.issue.externalId,
                      })
                    }}
                  </p>
                  <UButton
                    size="xs"
                    variant="soft"
                    icon="i-lucide-crosshair"
                    @click="reveal(revealTarget(outcome.result))"
                  >
                    {{ t('assistant.showOnBoard') }}
                  </UButton>
                </div>
              </div>
            </template>

            <template v-else-if="outcome.status === 'needs_input'">
              <div class="flex items-start gap-2 text-slate-200">
                <UIcon name="i-lucide-help-circle" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div class="space-y-2">
                  <p>{{ t(`assistant.needsInput.${outcome.reason}`) }}</p>
                  <div v-if="outcome.candidates.length" class="flex flex-wrap gap-1">
                    <UButton
                      v-for="candidate in outcome.candidates"
                      :key="candidate"
                      size="xs"
                      variant="soft"
                      :disabled="assistant.running"
                      data-testid="assistant-candidate"
                      @click="useCandidate(outcome, candidate)"
                    >
                      {{ candidate }}
                    </UButton>
                  </div>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="flex items-start gap-2 text-slate-200">
                <UIcon
                  name="i-lucide-circle-slash"
                  class="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
                />
                <p>{{ t('assistant.declined') }}</p>
              </div>
            </template>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
