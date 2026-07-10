<script setup lang="ts">
// Pre-existing branches of a task's PRIMARY target repo handed to the run as input, in two
// deliberately-disjoint modes (see `backend/docs/adr/0021-apriori-branches.md`):
//
//  - `reference` — read-only context (a spike / prototype / prior-art branch). The consuming
//    agents may read it (log/diff/open files) but never commit to or push it.
//  - `working` — the branch the run keeps building inside: it starts from and continues
//    committing into this branch instead of minting `cat-factory/<blockId>` off the default,
//    and the PR / CI-gate / merger all ride it.
//
// The cross-entry invariants the backend enforces at the write boundary are mirrored here so a
// forbidden combination is prevented in the UI rather than surfaced as a rejected write: at most
// ONE working entry, no duplicate names, the working entry frozen once a PR exists (its head is
// already pinned everywhere), and no working entry on a multi-repo task (v1 — peer legs would
// mint the user's branch name across every involved repo).
import { aprioriWorkingBranch } from '@cat-factory/contracts'
import type { AprioriBranch, Block } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const github = useGitHubStore()
const board = useBoardStore()

// The primary target repo is the one bound to the task's owning service frame — the sole
// repo↔frame linkage. Branch options come from the existing per-repo branches projection.
const frame = computed(() => board.serviceOf(props.block))
const repo = computed(() => (frame.value ? github.repoForBlock(frame.value.id) : undefined))
const repoBranches = computed(() => {
  const id = repo.value?.githubId
  return id != null ? (github.branches[id] ?? []) : []
})

// Load (and cache) the target repo's branches once it's resolved. Best-effort — a fetch failure
// just leaves the picker empty (the same repo the run clones, so a real failure is rare).
watch(
  () => repo.value?.githubId,
  (id) => {
    if (id != null) void github.loadBranches(id).catch(() => {})
  },
  { immediate: true },
)

// Write-boundary mirrors:
//  - a PR pins the run's branch, so the working entry is FROZEN (references stay editable);
//  - a multi-repo task (any involved service) BLOCKS working mode entirely.
const hasPullRequest = computed(() => !!props.block.pullRequest)
const isMultiRepo = computed(() => (props.block.involvedServiceIds ?? []).length > 0)

// A working entry set while single-repo becomes invalid the moment the task gains a second
// involved service (the backend rejects a working entry on a multi-repo task). Rather than let
// that stale entry ride along and fail the NEXT write wholesale, demote any working entry to
// `reference` on a multi-repo task — applied both to what we render and to what we persist, so
// the invariant is mirrored (not surfaced as a rejected write) and self-heals on the next save.
function normalize(entries: AprioriBranch[]): AprioriBranch[] {
  if (!isMultiRepo.value) return entries
  return entries.map((b) => (b.mode === 'working' ? { ...b, mode: 'reference' } : b))
}

const attached = computed<AprioriBranch[]>(() => normalize(props.block.aprioriBranches ?? []))
const attachedNames = computed(() => new Set(attached.value.map((b) => b.name)))
const workingName = computed(() => aprioriWorkingBranch(attached.value))

function isProtected(name: string): boolean {
  return repoBranches.value.find((b) => b.name === name)?.protected === true
}
// Building the run inside the repo's base branch has nothing to diff and no PR to open, so it's
// rejected at dispatch — surface it here as a non-selectable working target.
function isBaseBranch(name: string): boolean {
  return repo.value?.defaultBranch != null && name === repo.value.defaultBranch
}

function save(next: AprioriBranch[]) {
  board.updateBlock(props.block.id, { aprioriBranches: normalize(next) })
}

// ---- add / remove -----------------------------------------------------------
// The picker adds a branch as `reference` (the safe default — promoting to working is an
// explicit second action, guarded below).
const pickedName = ref<string | undefined>(undefined)
watch(pickedName, (name) => {
  if (name === undefined) return
  pickedName.value = undefined
  if (attachedNames.value.has(name)) return
  save([...attached.value, { name, mode: 'reference' }])
})

const branchItems = computed(() =>
  repoBranches.value.map((b) => ({
    label: b.name,
    value: b.name,
    disabled: attachedNames.value.has(b.name),
  })),
)

function remove(name: string) {
  save(attached.value.filter((b) => b.name !== name))
}

// ---- mode toggle ------------------------------------------------------------
// Promoting an entry to `working` demotes any existing working entry to `reference` in the same
// write, so the single-working invariant holds without an intermediate rejected state.
function setMode(name: string, mode: AprioriBranch['mode']) {
  save(
    attached.value.map((b) => {
      if (b.name === name) return { ...b, mode }
      if (mode === 'working' && b.mode === 'working') return { ...b, mode: 'reference' }
      return b
    }),
  )
}

// Whether a reference entry may be promoted to working: blocked outright on a multi-repo task,
// on the base branch, and once a PR has frozen the working slot.
function canPromote(name: string): boolean {
  return !isMultiRepo.value && !hasPullRequest.value && !isBaseBranch(name)
}
// The working entry is frozen once the PR exists (changing/dropping it would silently diverge).
const workingFrozen = computed(() => hasPullRequest.value && workingName.value !== undefined)

function modeMenu(entry: AprioriBranch) {
  const items: Array<{ label: string; icon: string; onSelect: () => void }> = []
  if (entry.mode === 'working') {
    if (!workingFrozen.value) {
      items.push({
        label: t('inspector.aprioriBranches.mode.reference'),
        icon: 'i-lucide-book-open-text',
        onSelect: () => setMode(entry.name, 'reference'),
      })
    }
  } else if (canPromote(entry.name)) {
    items.push({
      label: t('inspector.aprioriBranches.mode.working'),
      icon: 'i-lucide-hammer',
      onSelect: () => setMode(entry.name, 'working'),
    })
  }
  return [items]
}
// The mode dropdown is inert when there's no alternative mode to switch to.
function modeToggleDisabled(entry: AprioriBranch): boolean {
  return modeMenu(entry)[0]!.length === 0
}
// The working entry can't be removed while frozen by a PR; reference entries are always removable.
function removeDisabled(entry: AprioriBranch): boolean {
  return entry.mode === 'working' && workingFrozen.value
}
</script>

<template>
  <div v-if="repo" data-testid="apriori-branches">
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.aprioriBranches.title') }}
      </span>
    </div>

    <!-- Attached branches: one row each — name, mode badge + toggle, remove. -->
    <div v-if="attached.length" class="mb-1.5 space-y-1">
      <div
        v-for="entry in attached"
        :key="entry.name"
        class="flex items-center gap-1.5"
        data-testid="apriori-branch-row"
      >
        <UBadge
          size="sm"
          variant="soft"
          :color="entry.mode === 'working' ? 'primary' : 'neutral'"
          class="min-w-0"
          :data-mode="entry.mode"
          data-testid="apriori-branch-chip"
        >
          <UIcon
            :name="entry.mode === 'working' ? 'i-lucide-hammer' : 'i-lucide-book-open-text'"
            class="me-1 h-3 w-3 shrink-0"
          />
          <span class="truncate">{{ entry.name }}</span>
        </UBadge>

        <UDropdownMenu :items="modeMenu(entry)">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            trailing-icon="i-lucide-chevron-down"
            :disabled="modeToggleDisabled(entry)"
            data-testid="apriori-branch-mode"
          >
            {{
              entry.mode === 'working'
                ? t('inspector.aprioriBranches.mode.working')
                : t('inspector.aprioriBranches.mode.reference')
            }}
          </UButton>
        </UDropdownMenu>

        <UButton
          color="neutral"
          variant="link"
          size="xs"
          icon="i-lucide-x"
          class="ms-auto"
          :disabled="removeDisabled(entry)"
          :aria-label="t('inspector.aprioriBranches.remove', { branch: entry.name })"
          data-testid="apriori-branch-remove"
          @click="remove(entry.name)"
        />
      </div>
    </div>

    <!-- The picker: only usable once the workspace's GitHub App is connected. -->
    <UInputMenu
      v-if="github.connected"
      v-model="pickedName"
      :items="branchItems"
      value-key="value"
      icon="i-lucide-git-branch"
      :placeholder="t('inspector.aprioriBranches.searchPlaceholder')"
      class="w-full"
      data-testid="apriori-branch-search"
    />
    <div v-else class="text-[11px] text-slate-500">
      {{ t('inspector.aprioriBranches.connectFirst') }}
    </div>

    <!-- A protected branch pushed to by the run is likely to be rejected — warn, don't block. -->
    <div
      v-if="workingName && isProtected(workingName)"
      class="mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-950/40 p-2 text-[11px] text-amber-200/90"
      data-testid="apriori-branch-protected-warning"
    >
      <UIcon name="i-lucide-triangle-alert" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <span>{{ t('inspector.aprioriBranches.protectedWarning', { branch: workingName }) }}</span>
    </div>

    <div class="mt-1 text-[11px] text-slate-500">
      {{ t('inspector.aprioriBranches.hint') }}
      <template v-if="isMultiRepo">
        {{ t('inspector.aprioriBranches.multiRepoHint') }}
      </template>
      <template v-else-if="workingFrozen">
        {{ t('inspector.aprioriBranches.frozenHint') }}
      </template>
    </div>
  </div>
</template>
