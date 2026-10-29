<script setup lang="ts">
// The images attached to an EXISTING task as context, in the inspector. Writes through at once: an
// added image is uploaded against the block, a removed one is deleted. The add-task modal stages
// the same affordance until the task exists (TaskImageField is shared by both).
import type { Block } from '~/types/domain'
import type { TaskImageRecord } from '~/composables/api/taskImages'
import {
  describeFailure,
  type DescribedFailure,
} from '~/composables/pipelineErrorToast/describeFailure'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import FailureMessage from '~/components/common/FailureMessage.vue'
import TaskImageField from '~/components/tasks/TaskImageField.vue'

const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const api = useApi()
const ws = useWorkspaceStore()
const access = useWorkspaceAccess()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()
const blobs = useArtifactBlobs()

const records = ref<TaskImageRecord[]>([])
const loadError = ref<DescribedFailure | null>(null)
const busy = ref(false)

async function load() {
  try {
    const { artifacts } = await api.listBlockArtifacts(ws.requireId(), props.block.id)
    records.value = artifacts.filter((artifact) => artifact.kind === 'context')
    loadError.value = null
    for (const record of records.value) void blobs.resolve(record.id)
  } catch (e) {
    loadError.value = describeFailure(e)
  }
}

onMounted(load)
onBeforeUnmount(() => blobs.revokeAll())

const items = computed(() =>
  records.value.map((record) => ({
    key: record.id,
    name: record.view ?? t('tasks.images.unnamed'),
    url: blobs.urlFor(record.id),
  })),
)

async function add(files: File[]) {
  busy.value = true
  try {
    for (const file of files) {
      const { artifact } = await api.uploadTaskImage(ws.requireId(), props.block.id, file)
      records.value = [...records.value, artifact]
      void blobs.resolve(artifact.id)
    }
    actionToast.success('tasks.images.attached')
  } catch (e) {
    present(e, 'tasks.images.uploadFailed')
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  busy.value = true
  try {
    await api.deleteArtifact(ws.requireId(), id)
    records.value = records.value.filter((record) => record.id !== id)
  } catch (e) {
    present(e, 'tasks.images.removeFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <InspectorSection
    :title="t('tasks.images.heading')"
    :hint="t('tasks.images.hint')"
    :count="records.length"
  >
    <FailureMessage v-if="loadError" :failure="loadError" :title="t('tasks.images.loadFailed')" />
    <TaskImageField
      v-else
      :images="items"
      :busy="busy"
      :disabled="!access.canWriteBoard.value"
      @add="add"
      @remove="remove"
    />
  </InspectorSection>
</template>
