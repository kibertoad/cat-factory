<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { type DecisionRegister, type Project, parseDecisionRegister } from '@cat-factory/contracts'

// The decision register a decisions stage proposed, settled by a person as they accept it: each
// item's options with the recommended default preselected, a choice of their own allowed, and an
// optional note, beside the evidence the recommendation rests on and any required question the
// proposal left out. The settlement is sent as the checkpoint's revision; nothing is decided until
// a person accepts. The rail keys this on the proposal, so a new proposal mounts a fresh form.

const props = defineProps<{ project: Project; stageId: string; outcomeId: string }>()
const emit = defineEmits<{ accepted: [] }>()
const { t } = useI18n()
const projectViews = useProjectViewsStore()
const errors = usePipelineErrorToast()

const register = ref<DecisionRegister | null>(null)
const failed = ref(false)
const choices = ref<Record<string, string>>({})
const notes = ref<Record<string, string>>({})
const accepting = ref(false)

async function load() {
  failed.value = false
  try {
    const detail = await projectViews.outcome(props.project.id, props.outcomeId)
    const parsed = parseDecisionRegister(detail.body)
    if (!parsed.ok) throw new Error(parsed.issues.join('; '))
    register.value = parsed.value
    choices.value = Object.fromEntries(
      parsed.value.items.map((item) => [item.id, item.recommendation]),
    )
  } catch (e) {
    failed.value = true
    errors.present(e, 'projects.view.stages.decisions.loadFailed')
  }
}

onMounted(load)

const complete = computed(
  () => !!register.value?.items.every((item) => (choices.value[item.id] ?? '').trim() !== ''),
)

async function accept() {
  if (!register.value) return
  accepting.value = true
  try {
    await projectViews.acceptStage(props.project.id, props.stageId, {
      decisions: register.value.items.map((item) => ({
        itemId: item.id,
        choice: choices.value[item.id]!.trim(),
        ...(notes.value[item.id]?.trim() ? { note: notes.value[item.id]!.trim() } : {}),
      })),
    })
    emit('accepted')
  } catch (e) {
    errors.present(e, 'projects.view.stages.acceptFailed')
  } finally {
    accepting.value = false
  }
}
</script>

<template>
  <div class="mt-3 space-y-3" data-testid="project-stage-decisions">
    <div v-if="failed" class="flex items-center gap-2 text-xs text-error">
      {{ t('projects.view.stages.decisions.loadFailed') }}
      <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" @click="load">
        {{ t('projects.view.stages.decisions.retry') }}
      </UButton>
    </div>
    <p v-else-if="!register" class="text-xs text-dimmed">
      {{ t('projects.view.stages.decisions.loading') }}
    </p>
    <template v-else>
      <UAlert
        v-if="register.unanswered.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="
          t('projects.view.stages.decisions.unanswered', {
            questions: register.unanswered.join(', '),
          })
        "
      />
      <div
        v-for="item in register.items"
        :key="item.id"
        class="rounded-md border border-default p-3"
        data-testid="project-stage-decision"
      >
        <p class="text-sm font-medium text-highlighted">{{ item.question }}</p>
        <p v-if="item.rationale" class="mt-1 text-xs text-muted">{{ item.rationale }}</p>
        <ul v-if="item.evidence.length" class="mt-1 list-disc ps-4 text-xs text-dimmed">
          <li v-for="(line, i) in item.evidence" :key="i">{{ line }}</li>
        </ul>
        <URadioGroup
          v-model="choices[item.id]"
          class="mt-2"
          size="sm"
          :items="
            [...new Set([...item.options, item.recommendation])].map((o) => ({
              label: o,
              value: o,
            }))
          "
        />
        <UInput
          v-model="choices[item.id]"
          class="mt-2"
          size="sm"
          :placeholder="t('projects.view.stages.decisions.choice')"
        />
        <UInput
          v-model="notes[item.id]"
          class="mt-2"
          size="sm"
          :placeholder="t('projects.view.stages.decisions.note')"
        />
      </div>
      <UButton
        icon="i-lucide-check"
        size="sm"
        :disabled="!complete"
        :loading="accepting"
        data-testid="project-stage-decisions-accept"
        @click="accept"
      >
        {{ t('projects.view.stages.decisions.accept') }}
      </UButton>
    </template>
  </div>
</template>
