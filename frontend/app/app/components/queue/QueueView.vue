<script setup lang="ts">
import type { QueueEntry } from '~/utils/queueSections'
import QueueCard from '~/components/queue/QueueCard.vue'
import NotificationsInbox from '~/components/layout/NotificationsInbox.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

/**
 * The preview's home: every task across every service, in the column that says what it needs.
 *
 * Three columns, read left to right in order of urgency: what is stalled on you, what agents are
 * doing, what is finished and waiting to land. Work nobody has started sits under "In flight" as
 * a short list, and recent merges sit under "Ready to merge" behind a count, because neither is
 * what a person opening the app came to act on first. The canvas stays one click away as the
 * planning view.
 */
const { t } = useI18n()
const queueStore = useWorkspaceQueueStore()
const preview = useHomePreviewStore()
const access = useWorkspaceAccess()
const { checklist, canAct } = useSetupChecklist()

const sections = computed(() => queueStore.queue.sections)
const doneOpen = ref(false)

const serviceItems = computed(() => [
  { label: t('queue.filter.allServices'), value: '__all__' },
  ...queueStore.services.map((s) => ({ label: s.title, value: s.id })),
])
const serviceValue = computed({
  get: () => queueStore.serviceFilter ?? '__all__',
  set: (v: string) => (queueStore.serviceFilter = v === '__all__' ? null : v),
})

interface Column {
  id: 'needs_you' | 'in_flight' | 'ready_to_merge'
  icon: string
  entries: QueueEntry[]
}
const columns = computed<Column[]>(() => [
  { id: 'needs_you', icon: 'i-lucide-hand', entries: sections.value.needs_you },
  { id: 'in_flight', icon: 'i-lucide-loader', entries: sections.value.in_flight },
  { id: 'ready_to_merge', icon: 'i-lucide-git-merge', entries: sections.value.ready_to_merge },
])

const COLUMN_COPY: Record<Column['id'], { label: string; empty: string }> = {
  needs_you: { label: 'queue.columns.needsYou.label', empty: 'queue.columns.needsYou.empty' },
  in_flight: { label: 'queue.columns.inFlight.label', empty: 'queue.columns.inFlight.empty' },
  ready_to_merge: {
    label: 'queue.columns.readyToMerge.label',
    empty: 'queue.columns.readyToMerge.empty',
  },
}

const COLUMN_ACCENT: Record<Column['id'], string> = {
  needs_you: 'text-warning',
  in_flight: 'text-primary',
  ready_to_merge: 'text-success',
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden" data-testid="queue-view">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-4 pb-3 sm:px-6">
      <div class="flex items-baseline gap-2">
        <h1 class="text-xl font-semibold text-highlighted">{{ t('queue.title') }}</h1>
        <span class="text-sm text-muted" data-testid="queue-summary">
          {{
            t('queue.summary', {
              needsYou: sections.needs_you.length,
              ready: sections.ready_to_merge.length,
            })
          }}
        </span>
      </div>
      <div class="ms-auto flex flex-wrap items-center gap-2">
        <USelect
          v-model="serviceValue"
          :items="serviceItems"
          size="sm"
          class="w-48"
          :aria-label="t('queue.filter.service')"
          data-testid="queue-service-filter"
        />
        <!-- The inbox still holds what is NOT a task: platform alerts, budget thresholds, key
             drift. Kept here so the preview drops no signal the board shows. -->
        <NotificationsInbox />
        <UButton
          v-if="access.canWriteBoard.value"
          icon="i-lucide-plus"
          size="sm"
          data-testid="queue-describe-work"
          @click="preview.openDescribeWork(queueStore.serviceFilter)"
        >
          {{ t('queue.describeWork') }}
        </UButton>
      </div>
    </header>

    <!-- One line, once, instead of the operator's banners: the workspace cannot run tasks. -->
    <UAlert
      v-if="checklist.blocking"
      class="mx-4 mb-3 sm:mx-6"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('queue.setupBlocking', { done: checklist.done, total: checklist.total })"
      :description="canAct ? undefined : t('queue.setupBlockingNoAccess')"
      :actions="
        canAct
          ? [
              {
                label: t('queue.openSetup'),
                color: 'warning',
                onClick: () => preview.show('setup'),
              },
            ]
          : []
      "
      data-testid="queue-setup-line"
    />

    <div
      class="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-4 pb-6 sm:px-6 md:grid-cols-3 md:overflow-hidden"
    >
      <section
        v-for="column in columns"
        :key="column.id"
        class="flex min-h-0 flex-col rounded-xl border border-muted bg-elevated/40"
        data-testid="queue-column"
        :data-column="column.id"
      >
        <div class="flex items-center gap-2 px-3 pt-3 pb-2">
          <UIcon :name="column.icon" class="h-4 w-4" :class="COLUMN_ACCENT[column.id]" />
          <SectionLabel as="h2">{{ t(COLUMN_COPY[column.id].label) }}</SectionLabel>
          <UBadge class="ms-auto" color="neutral" variant="subtle" size="sm">
            {{ column.entries.length }}
          </UBadge>
        </div>

        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          <QueueCard v-for="entry in column.entries" :key="entry.task.id" :entry="entry" />
          <p v-if="column.entries.length === 0" class="px-1 py-6 text-center text-xs text-dimmed">
            {{ t(COLUMN_COPY[column.id].empty) }}
          </p>

          <!-- Not started: under In flight, because it is the next thing that column will hold. -->
          <template v-if="column.id === 'in_flight'">
            <USeparator class="my-3" />
            <SectionLabel as="h3" class="px-1">
              {{ t('queue.waiting.label', { count: sections.waiting.length }) }}
            </SectionLabel>
            <QueueCard v-for="entry in sections.waiting" :key="entry.task.id" :entry="entry" />
            <p v-if="sections.waiting.length === 0" class="px-1 text-xs text-dimmed">
              {{ t('queue.waiting.empty') }}
              <UButton
                v-if="access.canWriteBoard.value"
                variant="link"
                size="xs"
                class="p-0"
                @click="preview.openDescribeWork(queueStore.serviceFilter)"
              >
                {{ t('queue.describeWork') }}
              </UButton>
            </p>
          </template>

          <!-- Recent merges: a count, and the list on request. The queue is about now. -->
          <template v-if="column.id === 'ready_to_merge'">
            <USeparator class="my-3" />
            <div class="flex items-center gap-2 px-1 text-xs text-muted">
              <span data-testid="queue-done-count">
                {{ t('queue.done.count', { count: queueStore.queue.doneInWindow }) }}
              </span>
              <UButton
                v-if="queueStore.queue.doneInWindow > 0"
                variant="link"
                size="xs"
                class="p-0"
                @click="doneOpen = !doneOpen"
              >
                {{ doneOpen ? t('queue.done.hide') : t('queue.done.show') }}
              </UButton>
            </div>
            <!-- Merges with no completion time cannot be placed in the window. Said, not hidden. -->
            <p v-if="queueStore.queue.doneUndated > 0" class="px-1 text-2xs text-dimmed">
              {{ t('queue.done.undated', { count: queueStore.queue.doneUndated }) }}
            </p>
            <template v-if="doneOpen">
              <QueueCard v-for="entry in sections.done" :key="entry.task.id" :entry="entry" />
              <p
                v-if="queueStore.queue.doneInWindow > sections.done.length"
                class="px-1 text-2xs text-dimmed"
              >
                {{
                  t('queue.done.capped', {
                    shown: sections.done.length,
                    total: queueStore.queue.doneInWindow,
                  })
                }}
              </p>
            </template>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
