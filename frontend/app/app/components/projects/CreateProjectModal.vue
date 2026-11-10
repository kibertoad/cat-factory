<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppModal from '~/components/common/AppModal.vue'

// Create a project on this board: one of the kinds the deployment registers, a title, and the
// services its tasks read as context. The project is account-owned; this board is its home.
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

const kindOptions = computed(() =>
  projects.creatableKinds.map((k) => ({ label: k.label, value: k.id, description: k.description })),
)
const serviceOptions = computed(() =>
  services.catalog.map((s) => ({
    label: board.getBlock(s.frameBlockId)?.title ?? s.id,
    value: s.id,
  })),
)

watch(open, (isOpen) => {
  if (!isOpen) return
  kind.value = projects.creatableKinds[0]?.id ?? ''
  title.value = ''
  description.value = ''
  serviceIds.value = []
})

async function submit() {
  busy.value = true
  try {
    const created = await projects.create({
      kind: kind.value,
      title: title.value.trim(),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      serviceIds: serviceIds.value,
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
            :disabled="!kind || !title.trim()"
            data-testid="create-project-submit"
          >
            {{ t('projects.create.submit') }}
          </UButton>
        </div>
      </UForm>
    </template>
  </AppModal>
</template>
