<script setup lang="ts">
import type { WorkView } from '~/utils/workView'
import SectionLabel from '~/components/common/SectionLabel.vue'

/**
 * The sidebar's "Views" section: the queue and the canvas, as two views of one board.
 *
 * A view SWITCHER, not a list of destinations, which is why it is not a `nav` contribution: a
 * contribution opens something, and these change what the main area shows, so they need the
 * selected state a contribution has no shape for. Shown in every tier and every role: which view
 * a person works in is their choice, and neither view is an override of the other.
 */
defineProps<{ collapsed: boolean }>()

const { t } = useI18n()
const views = useWorkViewStore()
const queue = useWorkspaceQueueStore()

const ITEMS: { view: WorkView; icon: string; labelKey: string }[] = [
  { view: 'queue', icon: 'i-lucide-list-checks', labelKey: 'views.queue' },
  { view: 'board', icon: 'i-lucide-map', labelKey: 'views.board' },
]
</script>

<template>
  <section data-testid="work-view-switcher">
    <SectionLabel v-if="!collapsed" as="h2" class="mb-2 px-1">
      {{ t('views.title') }}
    </SectionLabel>
    <div class="space-y-1.5">
      <UButton
        v-for="item in ITEMS"
        :key="item.view"
        :block="!collapsed"
        :square="collapsed"
        size="sm"
        :color="views.view === item.view ? 'primary' : 'neutral'"
        :variant="views.view === item.view ? 'soft' : 'ghost'"
        :icon="item.icon"
        class="w-full"
        :class="collapsed ? 'justify-center' : 'justify-start'"
        :aria-label="collapsed ? t(item.labelKey) : undefined"
        :aria-current="views.view === item.view ? 'page' : undefined"
        :title="collapsed ? t(item.labelKey) : undefined"
        :data-testid="`work-view-${item.view}`"
        @click="views.show(item.view)"
      >
        <template v-if="!collapsed">
          <span class="flex-1 truncate text-start">{{ t(item.labelKey) }}</span>
          <!-- The queue's count: tasks an agent cannot continue until a person acts. -->
          <UBadge
            v-if="item.view === 'queue' && queue.needsYouCount > 0"
            size="sm"
            color="warning"
            variant="subtle"
            data-testid="work-view-queue-count"
          >
            {{ queue.needsYouCount }}
          </UBadge>
        </template>
      </UButton>
    </div>
  </section>
</template>
