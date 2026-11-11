<script setup lang="ts">
import type { ProjectCredentialReadiness } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import type { BadgeColor } from '~/utils/badge'

// Whether each credential the pinned definition declares resolves for this board, through the
// same resolver a project run reads. Each names its label, whether a run needs it at start, and
// how to obtain it, with a way to the panel where it is stored.

defineProps<{ credentials: ProjectCredentialReadiness[] }>()
const { t } = useI18n()
const ui = useUiStore()

const STATUS_COLOR: Record<ProjectCredentialReadiness['status'], BadgeColor> = {
  stored: 'success',
  missing: 'warning',
  reserved: 'error',
}
</script>

<template>
  <EmptyState
    v-if="credentials.length === 0"
    icon="i-lucide-key-round"
    :title="t('projects.view.credentials.none')"
    compact
  />
  <div v-else class="space-y-2" data-testid="project-credentials">
    <div
      v-for="credential in credentials"
      :key="credential.key"
      class="rounded-lg border border-default p-3"
      data-testid="project-credential"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-highlighted">{{ credential.label }}</span>
        <code class="text-xs text-muted">{{ credential.key }}</code>
        <UBadge
          :color="STATUS_COLOR[credential.status]"
          variant="subtle"
          size="sm"
          data-testid="project-credential-status"
        >
          {{ t(`projects.view.credentials.status.${credential.status}`) }}
        </UBadge>
      </div>
      <p class="mt-1 text-xs text-muted">
        {{
          credential.requiredAtStart
            ? t('projects.view.credentials.requiredAtStart')
            : t('projects.view.credentials.askedWhenNeeded')
        }}
      </p>
      <p v-if="credential.onboarding" class="mt-2 whitespace-pre-line text-xs">
        {{ credential.onboarding.instructions }}
      </p>
      <ULink
        v-if="credential.onboarding?.url"
        :to="credential.onboarding.url"
        target="_blank"
        class="mt-1 inline-block text-xs"
      >
        {{ credential.onboarding.url }}
      </ULink>
    </div>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-lock-keyhole"
      data-testid="project-credentials-store"
      @click="ui.openInfrastructure('capability-credentials')"
    >
      {{ t('projects.view.credentials.store') }}
    </UButton>
  </div>
</template>
