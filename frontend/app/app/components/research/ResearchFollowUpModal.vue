<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  RESEARCH_MODES,
  type Project,
  type ResearchMode,
  type ResearchProjectView,
} from '@cat-factory/contracts'
import AppModal from '~/components/common/AppModal.vue'
import { parseAdhocQuestions, revisitableQuestions } from '~/utils/research'

// Start a follow-up research task in the project: a mode, questions it adds, and for `clarify`
// or `refresh` the questions to revisit (none named means every one the mode covers). It becomes
// a `research` task under the project, started on the research pipeline.

const props = defineProps<{ project: Project; view: ResearchProjectView }>()
const open = defineModel<boolean>('open', { required: true })
const { t } = useI18n()
const research = useResearchStore()
const errors = usePipelineErrorToast()

const title = ref('')
const mode = ref<ResearchMode>('extend')
const questionsText = ref('')
const questionIds = ref<string[]>([])
const submitting = ref(false)

onModalOpen(open, () => {
  const answered = props.view.revisions.length > 0
  mode.value = answered ? 'extend' : 'initial'
  title.value = ''
  questionsText.value = ''
  questionIds.value = []
})

const modeItems = computed(() =>
  RESEARCH_MODES.map((value) => ({ label: t(`research.mode.${value}`), value })),
)
const revisitable = computed(() =>
  revisitableQuestions(props.view, mode.value).map((q) => ({ label: q.question, value: q.id })),
)
const questions = computed(() => parseAdhocQuestions(questionsText.value))

async function submit() {
  submitting.value = true
  try {
    const started = await research.startFollowUp(props.project, {
      title: title.value.trim() || t(`research.followUp.defaultTitle.${mode.value}`),
      mode: mode.value,
      questions: questions.value,
      questionIds: revisitable.value.length ? questionIds.value : [],
    })
    if (started) open.value = false
  } catch (e) {
    errors.present(e, 'research.followUp.failed')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" size="form" :title="t('research.followUp.title')">
    <template #body>
      <div class="space-y-4" data-testid="research-follow-up">
        <UFormField
          :label="t('research.followUp.modeLabel')"
          :help="t(`research.modeHelp.${mode}`)"
        >
          <USelect
            v-model="mode"
            :items="modeItems"
            class="w-full"
            data-testid="research-follow-up-mode"
          />
        </UFormField>
        <UFormField :label="t('research.followUp.titleLabel')">
          <UInput
            v-model="title"
            class="w-full"
            :placeholder="t(`research.followUp.defaultTitle.${mode}`)"
          />
        </UFormField>
        <UFormField
          :label="t('research.followUp.questionsLabel')"
          :help="t('research.followUp.questionsHelp')"
        >
          <UTextarea
            v-model="questionsText"
            class="w-full"
            :rows="4"
            data-testid="research-follow-up-questions"
          />
        </UFormField>
        <UFormField
          v-if="revisitable.length"
          :label="t('research.followUp.revisitLabel')"
          :help="t('research.followUp.revisitHelp')"
        >
          <USelectMenu
            v-model="questionIds"
            :items="revisitable"
            value-key="value"
            multiple
            class="w-full"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">
          {{ t('projects.common.cancel') }}
        </UButton>
        <UButton :loading="submitting" data-testid="research-follow-up-submit" @click="submit">
          {{ t('research.followUp.submit') }}
        </UButton>
      </div>
    </template>
  </AppModal>
</template>
