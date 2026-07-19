<script setup lang="ts">
// Inspector section for a task block: the tracker issues (Jira, GitHub Issues, …)
// attached to it as agent context. Attaching uses the SAME inline picker as task
// creation (source selector + in-repo search + paste-by-reference —
// ContextIssuePicker), NOT the old dropdown that opened a second, page-level
// "Import an issue…" modal on top of the inspector (stacked page-level modals
// don't interact here, so the menu appeared to open something with nothing
// clickable). Because the block already exists, a picked item is
// imported-when-needed then linked immediately via useContextLinking, scoped to
// this block's repo. Mirrors TaskContextDocs.vue; shown only when the task-source
// integration is available. Each linked issue shows its status so the structured
// nature of an issue is visible at a glance.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block } from '~/types/domain'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const tasks = useTasksStore()
const ui = useUiStore()
const toast = useToast()
const { linkPending, presentLinkFailures } = useContextLinking()

onMounted(() => {
  tasks.loadTasks().catch(() => {})
})

const linked = computed(() => tasks.tasksForBlock(props.block.id))
// Already-linked issues, so the inline picker filters them out / never re-offers them.
const chosenKeys = computed(() =>
  linked.value.map((issue) =>
    contextKey({ kind: 'task', source: issue.source, externalId: issue.externalId }),
  ),
)

const connected = computed(() => tasks.available && tasks.anyOffered)
// Trackers the user could connect right now to unlock the picker, when none is offered yet.
const connectableSources = computed(() =>
  tasks.available ? tasks.sources.filter((s) => !s.available) : [],
)
const connectMenu = computed<DropdownMenuItem[][]>(() => [
  connectableSources.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openTaskConnect(s.source),
  })),
])

const showPicker = ref(false)
const linking = ref(false)

// The block exists, so import-when-needed then link immediately (vs the add-task
// flow which stages the pick and links after create). linkPending never throws —
// it captures each failure with its cause for the shared presenter.
async function attach(item: PendingContext) {
  if (linking.value) return
  linking.value = true
  try {
    const failures = await linkPending(props.block.id, [item])
    if (failures.length) presentLinkFailures(failures, props.block.id)
    else toast.add({ title: t('tasks.contextIssues.attached'), icon: 'i-lucide-link' })
  } finally {
    linking.value = false
  }
}
</script>

<template>
  <InspectorSection
    v-if="tasks.available"
    :title="t('tasks.contextIssues.title')"
    :hint="t('tasks.contextIssues.hint')"
    :count="linked.length"
  >
    <template #actions>
      <UButton
        v-if="connected"
        color="neutral"
        variant="soft"
        size="xs"
        :icon="showPicker ? 'i-lucide-x' : 'i-lucide-plus'"
        @click="showPicker = !showPicker"
      >
        {{ showPicker ? t('common.done') : t('tasks.contextIssues.attach') }}
      </UButton>
      <UDropdownMenu
        v-else-if="connectableSources.length > 1"
        :items="connectMenu"
        :content="{ side: 'bottom', align: 'end' }"
      >
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
          {{ t('tasks.contextIssues.connectSource') }}
        </UButton>
      </UDropdownMenu>
      <UButton
        v-else-if="connectableSources.length === 1"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plug"
        @click="ui.openTaskConnect(connectableSources[0]!.source)"
      >
        {{ t('tasks.contextIssues.connectSourceNamed', { source: connectableSources[0]!.label }) }}
      </UButton>
    </template>

    <ContextIssuePicker
      v-if="showPicker && connected"
      :chosen-keys="chosenKeys"
      :scope-block-id="block.id"
      @pick="attach"
    />

    <div v-if="linked.length" class="space-y-1">
      <a
        v-for="issue in linked"
        :key="`${issue.source}:${issue.externalId}`"
        :href="issue.url"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
      >
        <UIcon
          :name="tasks.descriptorFor(issue.source)?.icon ?? 'i-lucide-square-check'"
          class="h-3.5 w-3.5 shrink-0 text-indigo-400"
        />
        <span class="truncate">{{ issue.externalId }} · {{ issue.title }}</span>
        <UBadge color="neutral" variant="soft" size="xs" class="ms-auto shrink-0">
          {{ issue.status }}
        </UBadge>
      </a>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('tasks.contextIssues.emptyHint') }}
    </p>
  </InspectorSection>
</template>
