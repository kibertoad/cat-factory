<script setup lang="ts">
// The command bar (⌘K / Ctrl+K) — a searchable launcher for every action that
// used to live as a button or draggable in the left panel. It is a fast path to
// pipelines, repositories, every integration and the settings surfaces. (Raw
// block creation is gone — services come from Bootstrap / Add-from-repo and tasks
// from the add-task flow.) Commands are assembled from the live stores so only
// available actions (connected integrations, etc.) show.

interface Command {
  id: string
  label: string
  group: string
  icon: string
  /** Extra words matched by the fuzzy filter beyond the label. */
  keywords?: string
  run: () => void | Promise<void>
}

const { t } = useI18n()
const ui = useUiStore()
const github = useGitHubStore()
const slack = useSlackStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const library = useFragmentLibraryStore()
const access = useWorkspaceAccess()

// The static destination catalog + its RBAC/availability gating now comes from
// the shared nav manifest (docs/initiatives/modular-vue-adoption.md, slice 1),
// rendered here as command entries. The DYNAMIC per-connection commands below
// (github/slack/doc/task connect + import) stay local to the palette — they vary
// per live connection, so they are not part of the static manifest this slice.
const { commandGroups, invoke } = useNavContributions()

const open = computed({
  get: () => ui.commandBarOpen,
  set: (v: boolean) => (v ? ui.openCommandBar() : ui.closeCommandBar()),
})

const query = ref('')
const activeIndex = ref(0)

// The per-connection integration commands the manifest deliberately doesn't
// carry: their label (connect vs manage) and set (one per document/task source)
// depend on live connection state. Gated by `integrations.manage`, they render
// under the palette's Integrations group.
const dynamicIntegrationCommands = computed<Command[]>(() => {
  if (!access.canManageIntegrations.value) return []
  const groupIntegrations = t('layout.commandBar.groups.integrations')
  const list: Command[] = []
  if (github.available) {
    list.push({
      id: 'github',
      label: github.connected
        ? t('layout.commandBar.cmd.githubManage')
        : t('layout.commandBar.cmd.githubConnect'),
      group: groupIntegrations,
      icon: 'i-lucide-github',
      keywords: t('layout.commandBar.keywords.github'),
      run: () => ui.openGitHub(),
    })
  }
  if (slack.available) {
    list.push({
      id: 'slack',
      label: slack.connected
        ? t('layout.commandBar.cmd.slackManage')
        : t('layout.commandBar.cmd.slackConnect'),
      group: groupIntegrations,
      icon: 'i-lucide-slack',
      keywords: t('layout.commandBar.keywords.slack'),
      run: () => ui.openSlack(),
    })
  }
  if (documents.available) {
    for (const src of documents.sources) {
      list.push({
        id: `doc-connect-${src.source}`,
        label: documents.isConnected(src.source)
          ? t('layout.commandBar.cmd.sourceManage', { source: src.label })
          : t('layout.commandBar.cmd.sourceConnect', { source: src.label }),
        group: groupIntegrations,
        icon: src.icon,
        keywords: t('layout.commandBar.keywords.documentSource'),
        run: () => ui.openDocumentConnect(src.source),
      })
    }
    if (documents.anyConnected) {
      list.push({
        id: 'doc-import',
        label: t('layout.commandBar.cmd.documentImport'),
        group: groupIntegrations,
        icon: 'i-lucide-file-down',
        keywords: t('layout.commandBar.keywords.documentImport'),
        run: () => ui.openDocumentImport(null),
      })
    }
  }
  if (tasks.available) {
    for (const src of tasks.sources) {
      list.push({
        id: `task-connect-${src.source}`,
        label: src.available
          ? t('layout.commandBar.cmd.sourceManage', { source: src.label })
          : t('layout.commandBar.cmd.sourceConnect', { source: src.label }),
        group: groupIntegrations,
        icon: src.icon,
        keywords: t('layout.commandBar.keywords.taskSource'),
        run: () => ui.openTaskConnect(src.source),
      })
    }
    if (tasks.anyOffered) {
      list.push({
        id: 'task-import',
        label: t('layout.commandBar.cmd.taskImport'),
        group: groupIntegrations,
        icon: 'i-lucide-file-down',
        keywords: t('layout.commandBar.keywords.taskImport'),
        run: () => ui.openTaskImport(null),
      })
    }
  }
  return list
})

const commands = computed<Command[]>(() => {
  // Flatten the reactively-gated manifest command groups (already in canonical
  // order: create, repositories, integrations, workspace, account), splicing the
  // dynamic per-connection commands into the Integrations group's position.
  const staticByGroup = new Map(commandGroups.value.map((g) => [g.group, g]))
  const asCommand = (g: (typeof commandGroups.value)[number]): Command[] =>
    g.items.map((ci) => ({
      id: ci.item.id,
      label: t(ci.labelKey),
      group: t(g.labelKey),
      icon: ci.item.icon,
      keywords: ci.keywordsKey ? t(ci.keywordsKey) : undefined,
      run: () => invoke(ci.item),
    }))
  const groupOrEmpty = (name: (typeof commandGroups.value)[number]['group']) => {
    const g = staticByGroup.get(name)
    return g ? asCommand(g) : []
  }
  return [
    ...groupOrEmpty('create'),
    ...groupOrEmpty('repositories'),
    ...groupOrEmpty('integrations'),
    ...dynamicIntegrationCommands.value,
    ...groupOrEmpty('workspace'),
    ...groupOrEmpty('account'),
  ]
})

const filtered = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) =>
    `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(q),
  )
})

// Group the filtered commands for rendering, preserving first-seen group order.
const groups = computed(() => {
  const map = new Map<string, Command[]>()
  for (const c of filtered.value) {
    const bucket = map.get(c.group)
    if (bucket) bucket.push(c)
    else map.set(c.group, [c])
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }))
})

// Keep the active highlight in range as the filter narrows the list.
watch(filtered, () => {
  activeIndex.value = 0
})

function run(cmd: Command) {
  ui.closeCommandBar()
  void cmd.run()
}

function onKeydown(event: KeyboardEvent) {
  const items = filtered.value
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % Math.max(items.length, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + items.length) % Math.max(items.length, 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const cmd = items[activeIndex.value]
    if (cmd) run(cmd)
  }
}

// Reset the query each time the bar opens, and focus the input.
const inputRef = ref<{ inputRef?: HTMLInputElement } | null>(null)
watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = ''
  activeIndex.value = 0
  void documents.probe()
  void tasks.probe()
  void github.probe()
  void library.probe()
  nextTick(() => inputRef.value?.inputRef?.focus())
})

// Global ⌘K / Ctrl+K toggles the bar from anywhere in the app.
function onGlobalKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.toggleCommandBar()
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

// Flat index of each command so per-group rendering can map to the global cursor.
function indexOf(cmd: Command) {
  return filtered.value.indexOf(cmd)
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-xl' }">
    <template #content>
      <div class="flex flex-col" @keydown="onKeydown">
        <div class="flex items-center gap-2 border-b border-slate-800 px-3">
          <UIcon name="i-lucide-search" class="h-4 w-4 shrink-0 text-slate-500" />
          <UInput
            ref="inputRef"
            v-model="query"
            variant="none"
            :placeholder="t('layout.commandBar.searchPlaceholder')"
            class="w-full"
            :ui="{ base: 'py-3 text-sm' }"
          />
          <UKbd value="esc" />
        </div>

        <div class="max-h-80 overflow-y-auto p-1.5">
          <p v-if="filtered.length === 0" class="px-3 py-6 text-center text-sm text-slate-500">
            {{ t('layout.commandBar.noMatches') }}
          </p>

          <div v-for="group in groups" :key="group.name" class="mb-1">
            <p
              class="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              {{ group.name }}
            </p>
            <button
              v-for="cmd in group.items"
              :key="cmd.id"
              type="button"
              class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm transition"
              :class="
                indexOf(cmd) === activeIndex
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-300 hover:bg-slate-800/60'
              "
              @mousemove="activeIndex = indexOf(cmd)"
              @click="run(cmd)"
            >
              <UIcon :name="cmd.icon" class="h-4 w-4 shrink-0 text-slate-400" />
              <span class="truncate">{{ cmd.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
