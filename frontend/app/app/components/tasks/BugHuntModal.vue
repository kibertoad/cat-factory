<script setup lang="ts">
// Bug hunt: pick a connected tracker, pick one of its boards, and let the platform rank that
// board's open, UNASSIGNED bugs by impact against implementation complexity. Confirming a
// candidate adopts it as a bug task in the chosen container and starts the bug-fix pipeline.
//
// The interactive dual of the recurring bug-triage schedule: same reading and same pipeline,
// but a human picks the bug instead of the oldest match being claimed unattended.
//
// Two states this deliberately renders rather than hides: a board whose ranking was
// unavailable or failed still shows its candidates (flagged as unassessed, since the scan is
// useful on its own), and a scan that hit its cap says so — a silently shortened list reads
// exactly like an exhaustive one.
import type { BugHuntCandidate, TaskSourceKind } from '~/types/domain'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t, d, n } = useI18n()
const ui = useUiStore()
const tasks = useTasksStore()
const board = useBoardStore()
const hunt = useBugHuntStore()
const toast = useToast()

const open = computed({
  get: () => ui.bugHunt !== null,
  set: (v: boolean) => {
    if (!v) ui.closeBugHunt()
  },
})
const back = useIntegrationBack(open)

const source = ref<TaskSourceKind | undefined>(undefined)
const boardId = ref('')
const issueType = ref('')
const labels = ref('')
const containerId = ref<string | undefined>(undefined)

// Containers an adopted bug can land in: every service frame and module on the board. Modules
// are labelled with their parent frame so the choice is unambiguous (same as the import modal).
const containerItems = computed(() =>
  board.blocks
    .filter((b) => b.level === 'frame' || b.level === 'module')
    .map((b) => ({
      label:
        b.level === 'module'
          ? `${board.getBlock(b.parentId ?? '')?.title ?? '?'} › ${b.title}`
          : b.title,
      value: b.id,
    })),
)

const sourceItems = computed(() =>
  tasks.offeredSources.map((s) => ({ label: s.label, value: s.source })),
)

const boardItems = computed(() =>
  hunt.boards.map((b) => ({
    label: b.key && b.key !== b.name ? `${b.name} (${b.key})` : b.name,
    value: b.id,
  })),
)

/** The tracker couldn't enumerate boards, so the user types the scope in themselves. */
const boardIsFreeText = computed(() => !hunt.boardsLoading && hunt.boardsError !== null)

const canHunt = computed(() => !!source.value && boardId.value.trim().length > 0)

watch(open, (isOpen) => {
  if (!isOpen) return
  hunt.reset()
  boardId.value = ''
  issueType.value = ''
  labels.value = ''
  source.value = ui.bugHunt?.source ?? tasks.offeredSources[0]?.source ?? undefined
  containerId.value = ui.bugHunt?.containerId ?? containerItems.value[0]?.value
  if (source.value) hunt.loadBoards(source.value)
})

// Switching tracker invalidates both the board list and any ranking already on screen — the
// candidates belong to the previous tracker's board and would otherwise sit there looking current.
watch(source, (next) => {
  boardId.value = ''
  hunt.reset()
  if (next) hunt.loadBoards(next)
})

async function runHunt() {
  if (!source.value || !canHunt.value) return
  const parsedLabels = labels.value
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const ok = await hunt.hunt(source.value, {
    board: boardId.value.trim(),
    ...(issueType.value.trim() ? { issueType: issueType.value.trim() } : {}),
    ...(parsedLabels.length ? { labels: parsedLabels } : {}),
  })
  if (!ok) {
    toast.add({
      title: t('bugHunt.huntFailed'),
      description: hunt.huntError ?? undefined,
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

async function adopt(candidate: BugHuntCandidate) {
  if (!source.value || !containerId.value) return
  try {
    const blockId = await hunt.adopt(source.value, candidate.externalId, containerId.value)
    if (!blockId) return // the user cancelled the personal-credential prompt
    ui.closeBugHunt()
    ui.select(blockId)
    toast.add({
      title: t('bugHunt.adopted', { id: candidate.externalId }),
      description: t('bugHunt.adoptedRunning'),
      icon: 'i-lucide-bug-play',
    })
  } catch (e) {
    toast.add({
      title: t('bugHunt.adoptFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

/** Colour the score chip by how good the impact-per-effort ratio is. */
function scoreColor(score: number): 'success' | 'primary' | 'neutral' {
  if (score >= 2) return 'success'
  if (score >= 1) return 'primary'
  return 'neutral'
}

/**
 * Confidence labels, as an exhaustive Record over the closed union so a new member fails the
 * typecheck rather than rendering a raw code (the enum→key drift guard).
 */
const CONFIDENCE_KEYS: Record<'high' | 'medium' | 'low', string> = {
  high: 'bugHunt.confidence.high',
  medium: 'bugHunt.confidence.medium',
  low: 'bugHunt.confidence.low',
}

/** The banner shown above the results, per analysis status — same exhaustive-Record guard. */
const STATUS_KEYS: Record<'ranked' | 'unavailable' | 'failed' | 'empty', string> = {
  ranked: 'bugHunt.status.ranked',
  unavailable: 'bugHunt.status.unavailable',
  failed: 'bugHunt.status.failed',
  empty: 'bugHunt.status.empty',
}
</script>

<template>
  <UModal v-model:open="open" :title="t('bugHunt.title')" :ui="{ content: 'max-w-3xl' }">
    <template #title>
      <IntegrationBackTitle :title="t('bugHunt.title')" @back="back" />
    </template>
    <template #body>
      <!-- No tracker offered (none connected/installed, or all disabled). -->
      <div v-if="!tasks.anyOffered" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">{{ t('bugHunt.connectFirst') }}</p>
        <div class="flex justify-center gap-2">
          <UButton
            v-for="s in tasks.sources"
            :key="s.source"
            color="primary"
            variant="soft"
            :icon="s.icon"
            @click="ui.openTaskConnect(s.source)"
          >
            {{ t('bugHunt.connectSource', { label: s.label }) }}
          </UButton>
        </div>
      </div>

      <!-- No service frame yet → nowhere for an adopted bug to land. -->
      <p v-else-if="!containerItems.length" class="text-center text-xs text-slate-500">
        {{ t('bugHunt.needFrameFirst') }}
      </p>

      <div v-else class="space-y-4">
        <p class="text-xs text-slate-400">{{ t('bugHunt.intro') }}</p>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField :label="t('bugHunt.tracker')">
            <USelect v-model="source" :items="sourceItems" class="w-full" />
          </UFormField>

          <UFormField :label="t('bugHunt.board')">
            <!-- A tracker that can't enumerate its boards gets a free-text field rather than
                 an empty picker, so the hunt is still usable. -->
            <UInput
              v-if="boardIsFreeText"
              v-model="boardId"
              :placeholder="t('bugHunt.boardPlaceholder')"
              class="w-full"
            />
            <USelect
              v-else
              v-model="boardId"
              :items="boardItems"
              :loading="hunt.boardsLoading"
              :placeholder="t('bugHunt.pickBoard')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('bugHunt.issueType')" :help="t('bugHunt.issueTypeHelp')">
            <UInput v-model="issueType" placeholder="bug" class="w-full" />
          </UFormField>

          <UFormField :label="t('bugHunt.labels')" :help="t('bugHunt.labelsHelp')">
            <UInput v-model="labels" placeholder="regression, checkout" class="w-full" />
          </UFormField>
        </div>

        <UFormField :label="t('bugHunt.adoptInto')">
          <USelect v-model="containerId" :items="containerItems" class="w-full" />
        </UFormField>

        <div class="flex items-center gap-2">
          <UButton
            color="primary"
            icon="i-lucide-radar"
            :loading="hunt.hunting"
            :disabled="!canHunt"
            @click="runHunt"
          >
            {{ t('bugHunt.run') }}
          </UButton>
          <span v-if="hunt.hunting" class="text-xs text-slate-400">
            {{ t('bugHunt.running') }}
          </span>
        </div>

        <!-- Results -->
        <div v-if="hunt.hasResult" class="space-y-3 border-t border-slate-800 pt-3">
          <p class="text-xs text-slate-400">
            {{ t(STATUS_KEYS[hunt.result!.analysisStatus]) }}
            <span v-if="hunt.result!.model" class="text-slate-500">
              {{ t('bugHunt.viaModel', { model: hunt.result!.model }) }}
            </span>
          </p>
          <p v-if="hunt.result!.truncated" class="text-xs text-amber-400">
            {{ t('bugHunt.truncated', { count: hunt.result!.scanned }) }}
          </p>

          <div
            v-for="candidate in hunt.candidates"
            :key="candidate.externalId"
            class="space-y-2 rounded-md border border-slate-800 p-3"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-2">
                  <UBadge
                    v-if="candidate.analysis"
                    :color="scoreColor(candidate.analysis.score)"
                    variant="soft"
                  >
                    {{ n(candidate.analysis.score) }}
                  </UBadge>
                  <UBadge v-else color="neutral" variant="soft">
                    {{ t('bugHunt.notAssessed') }}
                  </UBadge>
                  <ULink
                    :to="candidate.url"
                    target="_blank"
                    class="truncate text-sm font-medium text-slate-100"
                  >
                    {{ candidate.externalId }}: {{ candidate.title }}
                  </ULink>
                </div>
                <p v-if="candidate.analysis" class="text-xs text-slate-400">
                  {{
                    t('bugHunt.ratings', {
                      impact: candidate.analysis.impact,
                      complexity: candidate.analysis.complexity,
                      confidence: t(CONFIDENCE_KEYS[candidate.analysis.confidence]),
                    })
                  }}
                </p>
                <p v-if="candidate.analysis?.rationale" class="text-xs text-slate-300">
                  {{ candidate.analysis.rationale }}
                </p>
                <div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <span v-if="candidate.priority">{{ candidate.priority }}</span>
                  <span v-for="label in candidate.labels" :key="label">{{ label }}</span>
                  <span v-if="candidate.createdAt">
                    {{ d(new Date(candidate.createdAt), 'short') }}
                  </span>
                  <span>{{
                    t('bugHunt.comments', { count: candidate.commentCount }, candidate.commentCount)
                  }}</span>
                </div>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1">
                <UBadge v-if="candidate.analysis?.recommended" color="success" variant="subtle">
                  {{ t('bugHunt.recommended') }}
                </UBadge>
                <UButton
                  color="primary"
                  variant="soft"
                  icon="i-lucide-play"
                  size="xs"
                  :loading="hunt.adopting === candidate.externalId"
                  :disabled="hunt.adopting !== null"
                  @click="adopt(candidate)"
                >
                  {{ t('bugHunt.adopt') }}
                </UButton>
              </div>
            </div>
          </div>

          <p v-if="!hunt.candidates.length" class="text-center text-xs text-slate-500">
            {{ t('bugHunt.noCandidates') }}
          </p>
        </div>
      </div>
    </template>
  </UModal>
</template>
