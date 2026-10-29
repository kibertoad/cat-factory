<script setup lang="ts">
// The images a NEW task will carry, held as local files until the task exists (an upload needs its
// block id). The host commits them with `useTaskImageUpload` after the create.
import SectionLabel from '~/components/common/SectionLabel.vue'
import TaskImageField from '~/components/tasks/TaskImageField.vue'

const files = defineModel<File[]>({ required: true })

const { t } = useI18n()

/** One preview URL per staged file, revoked as soon as the file leaves the set. */
const previews = new Map<File, string>()

const items = computed(() =>
  files.value.map((file, index) => {
    let url = previews.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      previews.set(file, url)
    }
    return { key: String(index), name: file.name, url }
  }),
)

watch(files, (current) => {
  for (const [file, url] of previews) {
    if (current.includes(file)) continue
    URL.revokeObjectURL(url)
    previews.delete(file)
  }
})

onBeforeUnmount(() => {
  for (const url of previews.values()) URL.revokeObjectURL(url)
  previews.clear()
})

function remove(key: string) {
  const index = Number(key)
  files.value = files.value.filter((_, i) => i !== index)
}
</script>

<template>
  <div class="space-y-2">
    <SectionLabel as="span">{{ t('tasks.images.heading') }}</SectionLabel>
    <p class="text-2xs leading-snug text-dimmed">{{ t('tasks.images.hint') }}</p>
    <TaskImageField
      :images="items"
      @add="(added) => (files = [...files, ...added])"
      @remove="remove"
    />
  </div>
</template>
