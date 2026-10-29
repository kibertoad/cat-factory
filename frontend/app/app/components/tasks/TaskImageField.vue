<script setup lang="ts">
// The images attached to a task as context: thumbnails, a remove control on each, and a picker.
// Presentational on purpose, so the add-task modal (which STAGES files until the task exists) and
// the inspector (which writes through at once) render one affordance over two different stores.
import { INLINE_IMAGE_MEDIA_TYPES, MAX_TASK_IMAGES } from '@cat-factory/contracts'
import IconButton from '~/components/common/IconButton.vue'

export interface TaskImageFieldItem {
  key: string
  name: string
  /** An `<img>`-ready URL, absent while the bytes are still loading. */
  url?: string
}

const props = defineProps<{
  images: TaskImageFieldItem[]
  busy?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ add: [files: File[]]; remove: [key: string] }>()

const { t } = useI18n()

const accept = INLINE_IMAGE_MEDIA_TYPES.join(',')
const remaining = computed(() => Math.max(0, MAX_TASK_IMAGES - props.images.length))
/** Set when a pick held more images than there was room for, so the drop is said, not silent. */
const truncated = ref(false)
const picked = ref<File[] | null>(null)

watch(picked, (files) => {
  if (!files?.length) return
  const images = files.filter((file) => INLINE_IMAGE_MEDIA_TYPES.includes(file.type))
  truncated.value = images.length > remaining.value
  const kept = images.slice(0, remaining.value)
  // Cleared so the next pick is a fresh one; `reset` clears the native input's half of that.
  picked.value = null
  if (kept.length) emit('add', kept)
})
</script>

<template>
  <div class="space-y-2" data-testid="task-image-field">
    <div v-if="images.length" class="grid grid-cols-3 gap-2">
      <div
        v-for="image in images"
        :key="image.key"
        class="group relative aspect-video overflow-hidden rounded-md border border-default bg-elevated"
      >
        <img
          v-if="image.url"
          :src="image.url"
          :alt="image.name"
          class="h-full w-full object-cover"
        />
        <div v-else class="flex h-full items-center justify-center">
          <UIcon name="i-lucide-image" class="h-5 w-5 text-dimmed" />
        </div>
        <IconButton
          v-if="!disabled"
          color="error"
          variant="ghost"
          size="xs"
          icon="i-lucide-trash-2"
          class="absolute end-1 top-1 rounded-md bg-default/80"
          :label="t('tasks.images.remove', { name: image.name })"
          :disabled="busy"
          @click="emit('remove', image.key)"
        />
      </div>
    </div>
    <div class="flex items-center gap-2">
      <!-- Our own trigger button in the default slot, so the control keeps its accessible name. -->
      <UFileUpload
        v-model="picked"
        multiple
        reset
        size="xs"
        :accept="accept"
        :preview="false"
        :disabled="disabled || busy || remaining === 0"
        class="w-fit"
      >
        <template #default="{ open }">
          <UButton
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-image-plus"
            :loading="busy"
            :disabled="disabled || remaining === 0"
            :label="t('tasks.images.add')"
            data-testid="task-image-add"
            @click="open()"
          />
        </template>
      </UFileUpload>
      <span class="text-2xs text-dimmed">
        {{ t('tasks.images.count', { count: images.length, max: MAX_TASK_IMAGES }) }}
      </span>
    </div>
    <p v-if="truncated" class="text-2xs text-warning">
      {{ t('tasks.images.truncated', { max: MAX_TASK_IMAGES }) }}
    </p>
  </div>
</template>
