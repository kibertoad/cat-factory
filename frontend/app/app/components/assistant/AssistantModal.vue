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
//     name, a repository under a different owner) they are offered as chips that edit the prompt,
//     so the answer is one click plus submit rather than a retyped sentence.
//   - `declined` means nothing in the catalog matches. It renders the catalog, because "I can't
//     do that" without saying what it CAN do is the least useful answer this surface can give.
// Everything that IS a failure (no model wired, the budget spent, an unconfigured tracker, an
// issue already filed) arrives as an error and goes through the shared toast funnel with its
// reason, its detail and its request id, the same path a failed button press takes.
import type { AssistantActionId, AssistantOutcome } from '~/types/domain'
import { revealTarget } from './AssistantModal.logic'

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

// Read the capability on open rather than on mount: the modal is lazily loaded, and a deployment
// that wires a provider while the tab is open should not have to be reloaded to offer the box.
watch(open, (isOpen) => {
  if (!isOpen) return
  assistant.reset()
  void assistant.loadCapability().catch((error: unknown) => present(error, 'assistant.title'))
})

/** Editing the prompt clears the previous answer, so an outcome never sits under a new question. */
watch(prompt, () => {
  if (outcome.value) assistant.reset()
})

const canSubmit = computed(
  () => assistant.available && !assistant.running && prompt.value.trim().length > 0,
)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
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
 * It appends rather than replaces, because the candidate answers ONE argument of a request whose
 * other half the person already typed; replacing the sentence with a service name would throw
 * away what they asked for.
 */
function useCandidate(candidate: string): void {
  prompt.value = `${assistant.lastPrompt} (${candidate})`
  assistant.reset()
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

        <!-- No model wired: say so, rather than offering a box whose every submit would 503. -->
        <div
          v-if="assistant.capability && !assistant.available"
          class="flex items-start gap-2 rounded-md bg-slate-800/60 p-3 text-sm text-slate-300"
        >
          <UIcon name="i-lucide-plug" class="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <span>{{ t('assistant.unavailable') }}</span>
        </div>

        <template v-else>
          <UTextarea
            v-model="prompt"
            :rows="3"
            autofocus
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
              :disabled="!canSubmit"
              data-testid="assistant-submit"
              @click="submit"
            >
              {{ t('assistant.submit') }}
            </UButton>
            <span class="text-xs text-slate-500">{{ t('assistant.submitHint') }}</span>
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
                      @click="useCandidate(candidate)"
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
