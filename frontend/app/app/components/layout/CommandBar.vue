<script setup lang="ts">
// The command bar (⌘K / Ctrl+K) — a searchable launcher for every action that
// used to live as a button or draggable in the left panel. It is the primary way
// to create blocks and pipelines now that the draggable palettes are gone, and a
// fast path to every integration / settings surface. Commands are assembled from
// the live stores so only available actions (connected integrations, etc.) show.
import type { BlockType } from '~/types/domain'
import { BLOCK_TYPE_META } from '~/utils/catalog'

interface Command {
  id: string
  label: string
  group: string
  icon: string
  /** Extra words matched by the fuzzy filter beyond the label. */
  keywords?: string
  run: () => void | Promise<void>
}

const ui = useUiStore()
const board = useBoardStore()
const github = useGitHubStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const library = useFragmentLibraryStore()

const open = computed({
  get: () => ui.commandBarOpen,
  set: (v: boolean) => (v ? ui.openCommandBar() : ui.closeCommandBar()),
})

const query = ref('')
const activeIndex = ref(0)

// New top-level blocks are created without a drop position now, so stagger each
// one slightly off the canvas origin to keep them from stacking exactly.
let spawnCount = 0
function spawnPosition() {
  const offset = (spawnCount++ % 6) * 28
  return { x: 160 + offset, y: 160 + offset }
}

async function addBlock(type: BlockType) {
  const block = await board.addBlock(type, spawnPosition())
  ui.select(block.id)
}

const commands = computed<Command[]>(() => {
  const list: Command[] = []

  // ---- Create -------------------------------------------------------------
  list.push({
    id: 'new-pipeline',
    label: 'Build a pipeline',
    group: 'Create',
    icon: 'i-lucide-workflow',
    keywords: 'pipeline agents chain',
    run: () => ui.openBuilder(),
  })
  for (const type of Object.keys(BLOCK_TYPE_META) as BlockType[]) {
    const meta = BLOCK_TYPE_META[type]
    list.push({
      id: `add-block-${type}`,
      label: `Add ${meta.label} block`,
      group: 'Create',
      icon: meta.icon,
      keywords: 'block frame service create new',
      run: () => addBlock(type),
    })
  }

  // ---- Repositories -------------------------------------------------------
  if (github.available) {
    list.push({
      id: 'add-from-repo',
      label: 'Add service from existing repo',
      group: 'Repositories',
      icon: 'i-lucide-folder-git-2',
      keywords: 'github import existing',
      run: () => ui.openAddService(),
    })
  }
  list.push({
    id: 'bootstrap-repo',
    label: 'Bootstrap a new repo',
    group: 'Repositories',
    icon: 'i-lucide-git-branch-plus',
    keywords: 'scaffold create reference architecture',
    run: () => ui.openBootstrap(),
  })

  // ---- Integrations -------------------------------------------------------
  if (github.available) {
    list.push({
      id: 'github',
      label: github.connected ? 'Manage GitHub connection' : 'Connect GitHub',
      group: 'Integrations',
      icon: 'i-lucide-github',
      keywords: 'git repos pull requests issues',
      run: () => ui.openGitHub(),
    })
  }
  if (documents.available) {
    for (const src of documents.sources) {
      list.push({
        id: `doc-connect-${src.source}`,
        label: documents.isConnected(src.source) ? `Manage ${src.label}` : `Connect ${src.label}`,
        group: 'Integrations',
        icon: src.icon,
        keywords: 'document source prd rfc',
        run: () => ui.openDocumentConnect(src.source),
      })
    }
    if (documents.anyConnected) {
      list.push({
        id: 'doc-import',
        label: 'Import & spawn from documents',
        group: 'Integrations',
        icon: 'i-lucide-file-down',
        keywords: 'document import spawn',
        run: () => ui.openDocumentImport(null),
      })
    }
  }
  if (tasks.available) {
    for (const src of tasks.sources) {
      list.push({
        id: `task-connect-${src.source}`,
        label: tasks.isConnected(src.source) ? `Manage ${src.label}` : `Connect ${src.label}`,
        group: 'Integrations',
        icon: src.icon,
        keywords: 'task source tracker issues',
        run: () => ui.openTaskConnect(src.source),
      })
    }
    if (tasks.anyConnected) {
      list.push({
        id: 'task-import',
        label: 'Import issues',
        group: 'Integrations',
        icon: 'i-lucide-file-down',
        keywords: 'task import issues',
        run: () => ui.openTaskImport(null),
      })
    }
  }

  // ---- Workspace ----------------------------------------------------------
  if (library.available) {
    list.push({
      id: 'fragments',
      label: 'Context fragment library',
      group: 'Workspace',
      icon: 'i-lucide-book-marked',
      keywords: 'prompt fragments best practice guidelines context',
      run: () => ui.openFragmentLibrary(),
    })
  }
  list.push({
    id: 'merge-thresholds',
    label: 'Merge thresholds',
    group: 'Workspace',
    icon: 'i-lucide-git-merge',
    keywords: 'merge policy preset auto-merge ci',
    run: () => ui.openMergeThresholds(),
  })
  list.push({
    id: 'model-defaults',
    label: 'Default models for agents',
    group: 'Workspace',
    icon: 'i-lucide-cpu',
    keywords: 'model llm routing agent kind default',
    run: () => ui.openModelDefaults(),
  })

  return list
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
            placeholder="Search or run a command…"
            class="w-full"
            :ui="{ base: 'py-3 text-sm' }"
          />
          <UKbd value="esc" />
        </div>

        <div class="max-h-80 overflow-y-auto p-1.5">
          <p v-if="filtered.length === 0" class="px-3 py-6 text-center text-sm text-slate-500">
            No matching commands.
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
              class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition"
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
