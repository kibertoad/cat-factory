<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '@cat-factory/contracts'
import AppModal from '~/components/common/AppModal.vue'

// Replace a project's linked services: the services whose repositories and descriptions its tasks
// read as context. Offered from the account's service catalog, the only services a project may
// link.
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ project: Project }>()

const { t } = useI18n()
const services = useServicesStore()
const projects = useProjectsStore()
const board = useBoardStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

const selected = ref<string[]>([])
const busy = ref(false)

const options = computed(() =>
  services.catalog.map((s) => ({
    label: board.getBlock(s.frameBlockId)?.title ?? s.id,
    value: s.id,
  })),
)

watch(open, (isOpen) => {
  if (isOpen) selected.value = [...props.project.serviceIds]
})

async function save() {
  busy.value = true
  try {
    await projects.setServices(props.project.id, selected.value)
    actionToast.success('projects.linkServices.saved')
    open.value = false
  } catch (e) {
    present(e, 'projects.linkServices.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppModal
    size="form"
    v-model:open="open"
    :title="t('projects.linkServices.title')"
    :description="t('projects.linkServices.description')"
  >
    <template #body>
      <UForm class="space-y-4" data-testid="project-services-form" @submit="save">
        <UFormField :label="t('projects.linkServices.servicesLabel')">
          <USelectMenu
            v-model="selected"
            :items="options"
            value-key="value"
            multiple
            class="w-full"
            data-testid="project-services-select"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            {{ t('projects.common.cancel') }}
          </UButton>
          <UButton type="submit" :loading="busy" data-testid="project-services-save">
            {{ t('projects.linkServices.save') }}
          </UButton>
        </div>
      </UForm>
    </template>
  </AppModal>
</template>
