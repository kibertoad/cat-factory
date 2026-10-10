<script setup lang="ts">
import type { HomeView } from '~/utils/homePreview'
import SectionLabel from '~/components/common/SectionLabel.vue'

/**
 * The queue-first preview's own sidebar section: the views it adds, the one attention count, and
 * the way back to the current product.
 *
 * Rendered by `SideBar` only while the preview is on. It is a view SWITCHER, not a list of
 * destinations, which is why it is not a `nav` contribution: a contribution opens something, and
 * these change what the main area shows, so they need the selected state a contribution has no
 * shape for.
 */
defineProps<{ collapsed: boolean }>()

const { t } = useI18n()
const preview = useHomePreviewStore()
const queue = useWorkspaceQueueStore()
const access = useWorkspaceAccess()
const { checklist, canAct } = useSetupChecklist()

interface ViewItem {
  view: HomeView
  icon: string
  labelKey: string
  badge?: string
}

const views = computed<ViewItem[]>(() => [
  {
    view: 'queue',
    icon: 'i-lucide-list-checks',
    labelKey: 'homePreview.nav.queue',
    badge: queue.needsYouCount > 0 ? String(queue.needsYouCount) : undefined,
  },
  { view: 'board', icon: 'i-lucide-map', labelKey: 'homePreview.nav.board' },
  ...(canAct.value
    ? [
        {
          view: 'setup' as const,
          icon: 'i-lucide-list-todo',
          labelKey: 'homePreview.nav.setup',
          badge:
            checklist.value.done < checklist.value.total
              ? t('homePreview.nav.setupProgress', {
                  done: checklist.value.done,
                  total: checklist.value.total,
                })
              : undefined,
        },
      ]
    : []),
])
</script>

<template>
  <section data-testid="home-preview-nav">
    <SectionLabel v-if="!collapsed" as="h2" class="mb-2 px-1">
      {{ t('homePreview.nav.title') }}
    </SectionLabel>
    <div class="space-y-1.5">
      <UButton
        v-for="item in views"
        :key="item.view"
        :block="!collapsed"
        :square="collapsed"
        size="sm"
        :color="preview.view === item.view ? 'primary' : 'neutral'"
        :variant="preview.view === item.view ? 'soft' : 'ghost'"
        :icon="item.icon"
        class="w-full"
        :class="collapsed ? 'justify-center' : 'justify-start'"
        :aria-label="collapsed ? t(item.labelKey) : undefined"
        :aria-current="preview.view === item.view ? 'page' : undefined"
        :title="collapsed ? t(item.labelKey) : undefined"
        :data-testid="`home-preview-nav-${item.view}`"
        @click="preview.show(item.view)"
      >
        <template v-if="!collapsed">
          <span class="flex-1 truncate text-start">{{ t(item.labelKey) }}</span>
          <UBadge
            v-if="item.badge"
            size="sm"
            :color="item.view === 'queue' ? 'warning' : 'neutral'"
            variant="subtle"
          >
            {{ item.badge }}
          </UBadge>
        </template>
      </UButton>
      <UButton
        v-if="access.canWriteBoard.value"
        :block="!collapsed"
        :square="collapsed"
        size="sm"
        color="primary"
        variant="outline"
        icon="i-lucide-plus"
        class="w-full"
        :class="collapsed ? 'justify-center' : 'justify-start'"
        :aria-label="collapsed ? t('queue.describeWork') : undefined"
        :title="collapsed ? t('queue.describeWork') : undefined"
        data-testid="home-preview-nav-describe"
        @click="preview.openDescribeWork()"
      >
        <span v-if="!collapsed">{{ t('queue.describeWork') }}</span>
      </UButton>
    </div>
    <!-- The way back, in the rail too: basic mode starts railed, and a preview a person cannot
         leave from where they are is not a trial. -->
    <UButton
      :variant="collapsed ? 'ghost' : 'link'"
      color="neutral"
      size="xs"
      :square="collapsed"
      class="mt-2 w-full"
      :class="collapsed ? 'justify-center' : 'px-1'"
      icon="i-lucide-undo-2"
      :aria-label="collapsed ? t('homePreview.leave') : undefined"
      :title="collapsed ? t('homePreview.leave') : undefined"
      data-testid="home-preview-leave"
      @click="preview.setEnabled(false)"
    >
      <span v-if="!collapsed">{{ t('homePreview.leave') }}</span>
    </UButton>
  </section>
</template>
