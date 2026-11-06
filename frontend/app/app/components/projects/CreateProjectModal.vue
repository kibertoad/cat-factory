<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  type DescriptorFieldValues,
  type PinnableResearchDefinition,
  descriptorFieldDefaults,
  validateDescriptorFields,
} from '@cat-factory/contracts'
import AppModal from '~/components/common/AppModal.vue'
import DescriptorFields from '~/components/common/DescriptorFields.vue'

// Create a project on this board: one of the kinds the deployment registers, a title, and the
// services its tasks read as context. The project is account-owned; this board is its home. A kind
// that keeps research data also pins a research definition, with the values for its inputs.
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const projects = useProjectsStore()
const services = useServicesStore()
const board = useBoardStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

const kind = ref('')
const title = ref('')
const description = ref('')
const serviceIds = ref<string[]>([])
const busy = ref(false)

const definitions = ref<PinnableResearchDefinition[]>([])
const definitionsLoading = ref(false)
const definitionsFailed = ref(false)
const definitionId = ref('')
const inputValues = ref<DescriptorFieldValues>({})

const kindOptions = computed(() =>
  projects.kinds.map((k) => ({ label: k.label, value: k.id, description: k.description })),
)
const serviceOptions = computed(() =>
  services.catalog.map((s) => ({
    label: board.getBlock(s.frameBlockId)?.title ?? s.id,
    value: s.id,
  })),
)
const keepsResearch = computed(
  () => projects.kinds.find((k) => k.id === kind.value)?.data === 'research',
)
const definitionKeyOf = (d: PinnableResearchDefinition) => `${d.key}@${d.version}`
const definitionOptions = computed(() =>
  definitions.value.map((d) => ({
    label: t('projects.create.definitionOption', { title: d.title, version: d.version }),
    value: definitionKeyOf(d),
    description: d.brief,
  })),
)
const definition = computed(() =>
  definitions.value.find((d) => definitionKeyOf(d) === definitionId.value),
)
const inputProblems = computed(() =>
  definition.value ? validateDescriptorFields(definition.value.inputs, inputValues.value) : [],
)
const canSubmit = computed(
  () =>
    !!kind.value &&
    !!title.value.trim() &&
    (!keepsResearch.value || (!!definition.value && inputProblems.value.length === 0)),
)

onModalOpen(open, () => {
  kind.value = projects.kinds[0]?.id ?? ''
  title.value = ''
  description.value = ''
  serviceIds.value = []
  definitions.value = []
  definitionId.value = ''
  inputValues.value = {}
  definitionsFailed.value = false
  void loadDefinitions()
})

watch(keepsResearch, () => loadDefinitions())

/** Read the definitions once a research kind is picked, not for a kind that pins none. */
async function loadDefinitions() {
  if (!keepsResearch.value || definitions.value.length || definitionsLoading.value) return
  definitionsLoading.value = true
  definitionsFailed.value = false
  try {
    definitions.value = await projects.listPinnableDefinitions()
    definitionId.value = definitions.value[0] ? definitionKeyOf(definitions.value[0]) : ''
  } catch (e) {
    definitionsFailed.value = true
    present(e, 'projects.create.definitionsFailed')
  } finally {
    definitionsLoading.value = false
  }
}

watch(definition, (picked) => {
  inputValues.value = picked ? descriptorFieldDefaults(picked.inputs) : {}
})

async function submit() {
  busy.value = true
  try {
    const picked = keepsResearch.value ? definition.value : undefined
    const created = await projects.create({
      kind: kind.value,
      title: title.value.trim(),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      serviceIds: serviceIds.value,
      ...(picked
        ? {
            research: {
              definitionKey: picked.key,
              definitionVersion: picked.version,
              inputs: inputValues.value,
            },
          }
        : {}),
    })
    actionToast.success('projects.create.created', {
      params: { title: created.rootBlock.title },
    })
    open.value = false
  } catch (e) {
    present(e, 'projects.create.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppModal
    size="form"
    v-model:open="open"
    :title="t('projects.create.title')"
    :description="t('projects.create.description')"
  >
    <template #body>
      <UForm class="space-y-4" data-testid="create-project-form" @submit="submit">
        <UFormField :label="t('projects.create.kindLabel')">
          <USelect
            v-model="kind"
            :items="kindOptions"
            class="w-full"
            data-testid="create-project-kind"
          />
        </UFormField>
        <UFormField :label="t('projects.create.titleLabel')">
          <UInput
            v-model="title"
            class="w-full"
            :placeholder="t('projects.create.titlePlaceholder')"
            data-testid="create-project-title"
          />
        </UFormField>
        <UFormField :label="t('projects.create.descriptionLabel')">
          <UTextarea v-model="description" :rows="3" autoresize class="w-full" />
        </UFormField>
        <template v-if="keepsResearch">
          <UFormField
            :label="t('projects.create.definitionLabel')"
            :help="definition?.brief ?? t('projects.create.definitionHelp')"
          >
            <USkeleton v-if="definitionsLoading" class="h-8 w-full" />
            <p
              v-else-if="!definitionsFailed && !definitions.length"
              class="text-muted text-xs"
              data-testid="create-project-no-definitions"
            >
              {{ t('projects.create.noDefinitions') }}
            </p>
            <USelect
              v-else
              v-model="definitionId"
              :items="definitionOptions"
              class="w-full"
              data-testid="create-project-definition"
            />
          </UFormField>
          <DescriptorFields
            v-if="definition?.inputs.length"
            v-model="inputValues"
            :fields="definition.inputs"
            testid-prefix="create-project-input"
          />
        </template>
        <UFormField
          :label="t('projects.create.servicesLabel')"
          :help="t('projects.create.servicesHelp')"
        >
          <USelectMenu
            v-model="serviceIds"
            :items="serviceOptions"
            value-key="value"
            multiple
            class="w-full"
            data-testid="create-project-services"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            {{ t('projects.common.cancel') }}
          </UButton>
          <UButton
            type="submit"
            :loading="busy"
            :disabled="!canSubmit"
            data-testid="create-project-submit"
          >
            {{ t('projects.create.submit') }}
          </UButton>
        </div>
      </UForm>
    </template>
  </AppModal>
</template>
