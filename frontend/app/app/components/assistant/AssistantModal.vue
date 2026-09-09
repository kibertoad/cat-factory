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
// Everything that IS a failure (no model wired, the budget spent, an unconfigured tracker, an
// issue already filed) arrives as an error and goes through the shared toast funnel with its
// reason, its detail and its request id, the same path a failed button press takes.
import type { AssistantActionId, AssistantOutcome } from '~/types/domain'
import { ASSISTANT_PROMPT_MAX } from '~/types/domain'
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
 * Read the capability whenever the modal is open, INCLUDING the render it mounts on.
 *
 * `immediate` is load-bearing: the page mounts this component only while the open flag is set
 * (`<AssistantModal v-if="ui.assistantOpen">`), so `open` is already true at setup and a
 * change-only watcher never fires at all. Without it nothing reads the capability, and the modal
 * offers a box with no examples over a Run button that can never submit. Re-reading on each open
 * is what lets a provider wired while the tab is open be picked up with no reload.
 */
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    assistant.reset()
    void load()
  },
  { immediate: true },
)

/** Read what the assistant can do here. The failure is BOTH recorded and toasted. */
async function load(): Promise<void> {
  try {
    await assistant.loadCapability()
  } catch (error) {
    present(error, 'assistant.title')
  }
}

/** What the modal shows: the box, or the reason there is none. */
const surface = computed(() => assistantSurface(assistant.capabilityRead, assistant.available))

/** Whether the request can be sent. */
const gate = computed(() => submitGate(prompt.value, assistant.running, ASSISTANT_PROMPT_MAX))

/**
 * Why Run is disabled, where that is not already on screen.
 *
 * An empty box is answered by its own placeholder and the examples under it, and a turn in flight
 * by the button's spinner. A refused LENGTH is the one nothing else states, so it names both
 * numbers: a person who pasted a page has no way to see that it is 143 characters too long.
 */
const submitReason = computed<string | null>(() => {
  const state = gate.value
  return state.state === 'too_long'
    ? t('assistant.tooLong', { length: state.length, limit: state.limit })
    : null
})

/** Editing the prompt clears the previous answer, so an outcome never sits under a new question. */
watch(prompt, () => {
  if (outcome.value) assistant.reset()
})

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

        <!-- The capability read is still in flight. The only one of the three no-box states that
             clears itself, so it is the only one that may look like waiting. -->
        <div
          v-if="surface === 'reading'"
          class="flex items-center gap-2 text-sm text-slate-400"
          data-testid="assistant-reading"
        >
          <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
          <span>{{ t('assistant.reading') }}</span>
        </div>

        <!-- The read FAILED: this deployment may well have a model, and nobody can tell from here.
             So it offers the read again instead of explaining a configuration that may be fine. -->
        <div
          v-else-if="surface === 'unreadable'"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
        >
          <UIcon name="i-lucide-unplug" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div class="space-y-2">
            <p>{{ t('assistant.unreadable') }}</p>
            <UButton
              size="xs"
              variant="soft"
              icon="i-lucide-refresh-cw"
              data-testid="assistant-retry"
              @click="load"
            >
              {{ t('common.retry') }}
            </UButton>
          </div>
        </div>

        <!-- No model wired: say so, rather than offering a box whose every submit would 503. -->
        <div
          v-else-if="surface === 'unwired'"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
        >
          <UIcon name="i-lucide-plug" class="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <span>{{ t('assistant.unavailable') }}</span>
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
              data-testid="assistant-submit"
              @click="submit"
            >
              {{ t('assistant.submit') }}
            </UButton>
            <!-- The stated reason takes the keyboard hint's place while it applies. -->
            <span
              v-if="submitReason"
              class="text-xs text-amber-400"
              data-testid="assistant-submit-reason"
            >
              {{ submitReason }}
            </span>
            <span v-else class="text-xs text-slate-500">{{ t('assistant.submitHint') }}</span>
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
