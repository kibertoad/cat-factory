<script setup lang="ts">
// The actions on one row of the saved-pipeline LIBRARY: the two scope defaults, archive, the
// approval checkpoints of a built-in, clone, edit and delete. Split out of `PipelineBuilder.vue`
// along the seam `usePipelineLibraryActions` already draws: every one takes a library row and none
// touches the draft chain the rest of the builder edits.
import { ref } from 'vue'
import type { Pipeline } from '~/types/domain'
import IconButton from '~/components/common/IconButton.vue'
import PipelineApprovalsModal from '~/components/pipeline/PipelineApprovalsModal.vue'
import { usePipelineLibraryActions } from '~/composables/usePipelineLibraryActions'

defineProps<{ pipeline: Pipeline }>()

const { t } = useI18n()
const uiMode = useUiModeStore()
const { toggleArchive, toggleDefault, edit, removePipeline, clone } = usePipelineLibraryActions()

const approvalsOpen = ref(false)
</script>

<template>
  <div>
    <!-- The two DEFAULT claims, advanced-tier (see `toggleDefault`). An archived pipeline is not
         offered either: the backend refuses a hidden row as a default, and a control that can only
         fail is worse than no control. Safe to hide rather than a way to strand a claim, because
         the same rule refuses ARCHIVING a row that still holds one. -->
    <template v-if="uiMode.isAdvanced && !pipeline.archived && !pipeline.internal">
      <IconButton
        :icon="pipeline.isDefault ? 'i-lucide-star' : 'i-lucide-star-off'"
        :color="pipeline.isDefault ? 'primary' : 'neutral'"
        variant="ghost"
        size="xs"
        :label="
          pipeline.isDefault
            ? t('pipeline.builder.scopeDefault.releaseInteractive')
            : t('pipeline.builder.scopeDefault.claimInteractive')
        "
        @click="toggleDefault(pipeline, 'interactive')"
      />
      <IconButton
        :icon="pipeline.isUnattendedDefault ? 'i-lucide-bot' : 'i-lucide-bot-off'"
        :color="pipeline.isUnattendedDefault ? 'info' : 'neutral'"
        variant="ghost"
        size="xs"
        :label="
          pipeline.isUnattendedDefault
            ? t('pipeline.builder.scopeDefault.releaseUnattended')
            : t('pipeline.builder.scopeDefault.claimUnattended')
        "
        @click="toggleDefault(pipeline, 'unattended')"
      />
    </template>
    <!-- Archive/unarchive: organize the library without deleting. Works on built-ins too (view
         metadata, not structure). -->
    <IconButton
      :icon="pipeline.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
      color="neutral"
      variant="ghost"
      size="xs"
      :label="pipeline.archived ? t('pipeline.builder.unarchive') : t('pipeline.builder.archive')"
      @click="toggleArchive(pipeline)"
    />
    <!-- A built-in's checkpoints are the one part of it a workspace changes in place. A custom
         pipeline edits them in the builder with the rest of its steps. -->
    <IconButton
      v-if="pipeline.builtin"
      icon="i-lucide-shield"
      color="neutral"
      variant="ghost"
      size="xs"
      :label="t('pipeline.approvals.open')"
      data-testid="pipeline-approvals-open"
      @click="approvalsOpen = true"
    />
    <!-- Clone is available on every pipeline: it is how a read-only built-in template becomes an
         editable copy. -->
    <IconButton
      icon="i-lucide-copy"
      color="neutral"
      variant="ghost"
      size="xs"
      :label="pipeline.builtin ? t('pipeline.builder.cloneDefault') : t('pipeline.builder.clone')"
      @click="clone(pipeline)"
    />
    <!-- Built-in templates are read-only apart from their checkpoints, and the backend refuses a
         delete too; only custom pipelines edit in place or delete. -->
    <template v-if="!pipeline.builtin">
      <IconButton
        icon="i-lucide-pencil"
        color="neutral"
        variant="ghost"
        size="xs"
        :label="t('pipeline.builder.edit')"
        @click="edit(pipeline)"
      />
      <IconButton
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        size="xs"
        :label="t('pipeline.builder.delete')"
        @click="removePipeline(pipeline)"
      />
    </template>
    <PipelineApprovalsModal
      v-if="approvalsOpen"
      v-model:open="approvalsOpen"
      :pipeline="pipeline"
    />
  </div>
</template>
