<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  type DescriptorFieldValues,
  type PinnableProjectDefinition,
  descriptorFieldDefaults,
  validateDescriptorFields,
} from '@cat-factory/contracts'
import AppModal from '~/components/common/AppModal.vue'
import DescriptorFields from '~/components/common/DescriptorFields.vue'

// Create a project on this board: one of the kinds the deployment registers, a title, and the
// services its tasks read as context. The project is account-owned; this board is its home. A kind
// that pins a definition also takes one of its own, with the values for its inputs.
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

const definitions = ref<PinnableProjectDefinition[]>([])
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
const definitionUse = computed(
  () => projects.kinds.find((k) => k.id === kind.value)?.definition,
)
const pinsDefinition = computed(() => definitionUse.value !== undefined)
const definitionKeyOf = (d: PinnableProjectDefinition) => `${d.key}@${d.version}`
const definitionOptions = computed(() =>
  definitions.value.map((d) => ({
    label: t('projects.create.definitionOption', { title: d.title, version: d.version }),
    value: definitionKeyOf(d),
    description: d.summary,
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
    (definition.value
      ? inputProblems.value.length === 0
      : definitionUse.value !== 'required'),
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

// Definitions are per kind, so a different kind reads its own.
watch(kind, () => {
  definitions.value = []
  definitionId.value = ''
  void loadDefinitions()
})

/** Read the picked kind's definitions, not for a kind that pins none. */
async function loadDefinitions() {
  if (!pinsDefinition.value || definitions.value.length || definitionsLoading.value) return
  const forKind = kind.value
  definitionsLoading.value = true
  definitionsFailed.value = false
  try {
    const listed = await projects.listPinnableDefinitions(forKind)
    // A kind switched while the read was in flight owns the list now.
    if (kind.value !== forKind) return
    definitions.value = listed
    definitionId.value = definitionUse.value === 'required' ? defaultDefinitionId(listed) : ''
  } catch (e) {
    definitionsFailed.value = true
    present(e, 'projects.create.definitionsFailed')
  } finally {
    definitionsLoading.value = false
  }
}

/**
 * The newest version of the first listed key: the list holds every pinnable version, and a
 * project should not pin a superseded one unless someone picks it.
 */
function defaultDefinitionId(list: readonly PinnableProjectDefinition[]): string {
  const first = list[0]
  if (!first) return ''
  const newest = list
    .filter((d) => d.key === first.key)
    .reduce((best, d) => (d.version > best.version ? d : best))
  return definitionKeyOf(newest)
}

watch(definition, (picked) => {
  inputValues.value = picked ? descriptorFieldDefaults(picked.inputs) : {}
})

async function submit() {
  busy.value = true
  try {
    const picked = pinsDefinition.value ? definition.value : undefined
    const created = await projects.create({
      kind: kind.value,
      title: title.value.trim(),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      serviceIds: serviceIds.value,
      ...(picked
        ? {
            definition: {
              key: picked.key,
              version: picked.version,
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
        <template v-if="pinsDefinition">
          <UFormField
            :label="t('projects.create.definitionLabel')"
            :help="definition?.summary ?? t('projects.create.definitionHelp')"
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
