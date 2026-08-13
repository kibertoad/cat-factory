<script setup lang="ts">
// Bug hunt: pick a connected tracker, scope the scan, and let the platform rank that board's
// open, UNASSIGNED bugs by impact against implementation complexity. Confirming a candidate
// adopts it as a bug task in the chosen container and starts the bug-fix pipeline.
//
// What SCOPES the scan depends on the tracker, and the source states which (`repoBacked`): a
// repo-backed one (GitHub Issues, GitLab Issues) hunts the repository the chosen service is
// linked to and offers NO board control, because its issues live in one repo per service and the
// only honest answer is the one the backend resolves. Every other tracker names a board of its
// own. Never a picker either way that could aim a hunt at a repository this board holds no
// service for.
//
// The interactive dual of the recurring bug-triage schedule: same reading and same pipeline,
// but a human picks the bug instead of the oldest match being claimed unattended.
//
// Two states this deliberately renders rather than hides: a board whose ranking was
// unavailable or failed still shows its candidates (flagged as unassessed, since the scan is
// useful on its own), and a scan that hit its cap says so, because a silently shortened list
// reads exactly like an exhaustive one.
//
// The tracker selector doubles as the "add a tracker" affordance (the same two-tier menu
// `<ContextIssuePicker>` renders, off the shared `buildSourceChoices` + `sourceMenuItems`): a hunt
// is a common place to find out the tracker holding the bugs isn't connected here yet, and the
// answer has to be a route to that tracker's own connect screen rather than "go find the
// Integrations hub". The connect modal opens OVER the hunt, so nothing typed here is lost.
//
// Where an adopted bug lands comes from `useContainerTargets`, shared with `<TaskImportModal>`:
// both are opened from the same frame-header buttons with the same payload, so the frame either
// answers "which service" for both or for neither.
import type { TaskSourceReadReason } from '@cat-factory/contracts'
import type {
  BugHuntAnalysisStatus,
  BugHuntCandidate,
  BugHuntConfidence,
  TaskSourceKind,
} from '~/types/domain'
import {
  type AddSourceLabels,
  addChoicesOf,
  buildSourceChoices,
  menuIsPickable,
  reconcileSource,
  sourceMenuItems,
} from '~/utils/sourcePicker'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import { appliesIntakePredicate } from '~/utils/intakePredicates'
import { boardFromService as isBoardFromService, huntRequest } from './BugHuntModal.logic'

const { t, d, n } = useI18n()
const ui = useUiStore()
const tasks = useTasksStore()
const hunt = useBugHuntStore()
const board = useBoardStore()
const github = useGitHubStore()
const toast = useToast()
const { present } = usePipelineErrorToast()

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
// Where an adopted bug lands. Stated rather than asked when the frame the hunt was opened from is
// the only legal target; re-resolved through the board, so a frame deleted mid-hunt widens back.
const {
  pinned: pinnedContainer,
  items: containerItems,
  containerId,
  stated: containerStated,
  reset: resetContainer,
} = useContainerTargets(() => ui.bugHunt?.containerId)

const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))

/**
 * Whether the picked tracker will actually apply the issue-type predicate. Asked of the source's
 * own declaration, because a hunt whose type filter is silently dropped ranks and adopts whatever
 * is oldest and open, and `run` sends the `bug` default whether or not the user typed one.
 */
const issueTypeApplies = computed(() => appliesIntakePredicate(descriptor.value, 'issueType'))

/**
 * Wording for an addable tracker, as an exhaustive map over the add actions a TRACKER menu can
 * carry: `enable` is connected but toggled off for this workspace, so the user is never told to
 * "connect" something they already connected.
 */
const ADD_LABEL: AddSourceLabels<'connect' | 'enable'> = {
  connect: (label) => t('bugHunt.connectSource', { label }),
  enable: (label) => t('bugHunt.enableSource', { label }),
}

// Two-tier tracker menu: pick one the workspace already offers, or add one it doesn't.
const sourceChoices = computed(() => buildSourceChoices(tasks.sources, source.value))
const sourceMenu = computed(() =>
  sourceMenuItems(sourceChoices.value, {
    onSelect: (s) => {
      source.value = s
    },
    onAdd: addSource,
    addLabel: ADD_LABEL,
  }),
)
/** One entry decides nothing, so the tracker is named as a label rather than as a dead control. */
const sourcePickable = computed(() => menuIsPickable(sourceChoices.value))

/** The trackers that can be added: the empty state's buttons, where none is offered yet. */
const addableSources = computed(() => addChoicesOf(sourceChoices.value))

/**
 * The tracker the user left to add, so it becomes the selection the moment it turns up
 * offered (the connect modal re-probes on success and this hunt stays open underneath it).
 * Also the reconcile trigger for a source that STOPS being offered — disconnected, or
 * toggled off in settings while the hunt sat open.
 */
const awaitingConnect = ref<TaskSourceKind | null>(null)
function addSource(s: TaskSourceKind) {
  awaitingConnect.value = s
  ui.openTaskConnect(s)
}
watch(
  () => tasks.offeredSources.map((s) => s.source),
  (offered) => {
    const next = reconcileSource(offered, source.value, awaitingConnect.value)
    if (next && next === awaitingConnect.value) awaitingConnect.value = null
    if (next !== source.value) source.value = next
  },
)

const boardItems = computed(() =>
  hunt.boards.map((b) => ({
    label: b.key && b.key !== b.name ? `${b.name} (${b.key})` : b.name,
    value: b.id,
  })),
)

/** This tracker's board is the chosen service's own repository (see the logic module). */
const boardFromService = computed(() => isBoardFromService(descriptor.value))

/**
 * WHICH repository a repo-backed hunt will read, named before it runs.
 *
 * The premise of this whole branch is that the platform picks the board on the user's behalf, so
 * withholding the value until the results block (`scannedBoard`) states it only after a billable
 * scan has already been paid for. Resolved the way the backend resolves it — walk the chosen
 * container up to its service frame, read that frame's repo link — so the two cannot name
 * different repositories. Null while the projection is still loading or the service holds no
 * link; the field then says what it always said, and the not-linked case stays the backend's to
 * refuse (`boardNeedsRepo`), since an unloaded projection and an unlinked service look identical
 * from here.
 */
const scopedRepo = computed(() => {
  const container = containerId.value ? board.getBlock(containerId.value) : undefined
  const frame = container ? board.serviceOf(container) : undefined
  const repo = frame ? github.repoForBlock(frame.id) : undefined
  return repo ? `${repo.owner}/${repo.name}` : null
})

/**
 * The service this hunt is scoped to has no repository linked, so it has no issues to read. The
 * one scan failure worded here instead of in a toast: it names something to fix on this board,
 * and it belongs beside the scope it invalidates.
 */
const REPO_NOT_LINKED: TaskSourceReadReason = 'repo_not_linked'
const huntNeedsRepo = computed(() => hunt.huntErrorReason === REPO_NOT_LINKED)

/**
 * The tracker CANNOT enumerate boards, so the user types the scope in themselves. Keyed on the
 * backend's reason code, not on "any error": an unreachable tracker or an expired token would
 * otherwise present as a free-text field that simply moves the same failure to the next click.
 */
const BOARDS_UNSUPPORTED: TaskSourceReadReason = 'boards_unsupported'
const boardIsFreeText = computed(
  () => !hunt.boardsLoading && hunt.boardsErrorReason === BOARDS_UNSUPPORTED,
)

/**
 * The refusals this surface words ITSELF, keyed on the backend's reason.
 *
 * The backend does not localize prose, so a reason with no entry here renders the server's
 * untranslated English — the honest last resort for a cause this modal was not built to explain,
 * and the wrong answer for one it was. Both entries are reachable only from a client that
 * disagrees with the backend about which sources are repo-backed (a stale SPA build, a raced
 * `repoBacked` read), which is exactly when a user is least served by raw backend prose.
 * `repo_not_linked` is deliberately absent: it is not a message but a warning rendered beside the
 * scope it invalidates.
 */
const REFUSAL_KEYS: Partial<Record<TaskSourceReadReason, string>> = {
  board_from_service: 'bugHunt.refusal.boardFromService',
  missing_board: 'bugHunt.refusal.missingBoard',
}
function refusalText(reason: string | null, fallback: string | null): string | null {
  const key = reason ? REFUSAL_KEYS[reason as TaskSourceReadReason] : undefined
  return key ? t(key) : fallback
}

/** A board read that failed for a reason the user has to fix — shown, never silently swallowed. */
const boardsFailure = computed(() =>
  !hunt.boardsLoading && hunt.boardsError !== null && !boardIsFreeText.value
    ? refusalText(hunt.boardsErrorReason, hunt.boardsError)
    : null,
)

/**
 * A tracker date the SPA can actually format. A provider reports `createdAt` as an opaque
 * string, so an unparseable one must render as nothing rather than as "Invalid Date".
 */
function createdAtDate(createdAt: string): Date | null {
  if (!createdAt) return null
  const parsed = new Date(createdAt)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** The scan this form currently describes, or null while it does not describe one. */
const request = computed(() =>
  huntRequest({
    source: descriptor.value,
    containerId: containerId.value,
    board: boardId.value,
    issueType: issueType.value,
    labels: labels.value,
  }),
)
const canHunt = computed(() => request.value !== null)

watch(open, (isOpen) => {
  if (!isOpen) return
  hunt.reset()
  boardId.value = ''
  issueType.value = ''
  labels.value = ''
  awaitingConnect.value = null
  source.value = ui.bugHunt?.source ?? tasks.offeredSources[0]?.source ?? undefined
  resetContainer()
  loadBoardsFor(source.value)
})

// Switching tracker invalidates both the board list and any ranking already on screen: the
// candidates belong to the previous tracker's board and would otherwise sit there looking current.
watch(source, (next) => {
  boardId.value = ''
  hunt.reset()
  loadBoardsFor(next)
})

// For a repo-backed tracker the service IS the board, so moving the hunt to another service moves
// it to another repository: the shortlist on screen belongs to the old one and must go with it.
// A repo-less tracker keeps its results, since the container only decides where an adopted bug
// lands and the scan is still of the board that was asked for.
watch(containerId, () => {
  if (boardFromService.value) hunt.reset()
})

/**
 * Boards are listed only for a tracker that HAS a board to choose; asking otherwise is refused
 * server-side. The other branch is not a no-op: the previous tracker's list (or the warning its
 * failed listing left behind) has to go, or it renders under a tracker with no board field.
 */
function loadBoardsFor(next: TaskSourceKind | undefined) {
  if (!next) return
  if (isBoardFromService(tasks.descriptorFor(next))) {
    hunt.dropBoards(next)
    // The repo projection is lazy and nothing on the board opens it, so the field that names the
    // repository this hunt will read asks for it here — only on the branch that has one.
    void github.ensureLoaded().catch(() => {})
  } else hunt.loadBoards(next)
}

async function runHunt() {
  const input = request.value
  if (!source.value || !input) return
  const ok = await hunt.hunt(source.value, input)
  if (!ok && !huntNeedsRepo.value) {
    toast.add({
      title: t('bugHunt.huntFailed'),
      description: refusalText(hunt.huntErrorReason, hunt.huntError) ?? undefined,
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
    present(e, 'bugHunt.adoptFailed')
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
const CONFIDENCE_KEYS: Record<BugHuntConfidence, string> = {
  high: 'bugHunt.confidence.high',
  medium: 'bugHunt.confidence.medium',
  low: 'bugHunt.confidence.low',
}

/** The banner shown above the results, per analysis status — same exhaustive-Record guard. */
const STATUS_KEYS: Record<BugHuntAnalysisStatus, string> = {
  ranked: 'bugHunt.status.ranked',
  unavailable: 'bugHunt.status.unavailable',
  failed: 'bugHunt.status.failed',
  over_budget: 'bugHunt.status.over_budget',
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
        <div class="flex flex-wrap justify-center gap-2">
          <UButton
            v-for="choice in addableSources"
            :key="choice.source"
            color="primary"
            variant="soft"
            :icon="choice.icon"
            @click="addSource(choice.source)"
          >
            {{ ADD_LABEL[choice.action](choice.label) }}
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
            <!-- The selector is also the way to ADD a tracker: each entry in the second group
                 opens that tracker's own connect screen over this modal, so the hunt (and
                 anything typed into it) is still here when the user comes back. With a single
                 entry there is nothing to decide, so the tracker is named as plain text instead:
                 a chevron that opens a one-item menu promises a choice that isn't there. -->
            <UDropdownMenu
              v-if="sourcePickable"
              :items="sourceMenu"
              :content="{ side: 'bottom', align: 'start' }"
              class="w-full"
            >
              <UButton
                color="neutral"
                variant="soft"
                :icon="descriptor?.icon"
                trailing-icon="i-lucide-chevron-down"
                class="w-full justify-between"
              >
                <span class="truncate">{{ descriptor?.label ?? t('bugHunt.pickTracker') }}</span>
              </UButton>
            </UDropdownMenu>
            <p v-else class="flex items-center gap-1.5 py-1 text-sm text-slate-300">
              <UIcon v-if="descriptor?.icon" :name="descriptor.icon" class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ descriptor?.label ?? t('bugHunt.pickTracker') }}</span>
            </p>
          </UFormField>

          <UFormField :label="t('bugHunt.board')">
            <!-- This tracker's issues belong to one repository per service, so the board is
                 STATED rather than asked: the repository the service below is linked to. No
                 control at all, because every value one could offer here is either that repo
                 (nothing to choose) or another one this board holds no service for. -->
            <p
              v-if="boardFromService"
              class="flex items-center gap-1.5 py-1 text-sm text-slate-300"
            >
              <UIcon name="i-lucide-folder-git-2" class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ scopedRepo ?? t('bugHunt.boardFromService') }}</span>
            </p>
            <!-- A tracker that can't enumerate its boards gets a free-text field rather than
                 an empty picker, so the hunt is still usable. -->
            <UInput
              v-else-if="boardIsFreeText"
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
            <!-- The service holds no repository, so there are no issues to read. Said here
                 rather than in a toast: it invalidates the scope named right above it. -->
            <p v-if="huntNeedsRepo" class="mt-1 text-xs text-amber-400">
              {{ t('bugHunt.boardNeedsRepo') }}
            </p>
            <!-- A board read that failed for a fixable reason (unreachable site, expired
                 token): named, so the user isn't left with an empty picker and no cause. -->
            <p v-else-if="boardsFailure" class="mt-1 text-xs text-amber-400">
              {{ t('bugHunt.boardsFailed', { reason: boardsFailure }) }}
            </p>
          </UFormField>

          <UFormField
            :label="t('bugHunt.issueType')"
            :help="issueTypeApplies ? t('bugHunt.issueTypeHelp') : undefined"
          >
            <UInput v-if="issueTypeApplies" v-model="issueType" placeholder="bug" class="w-full" />
            <!-- Not a disabled input: this tracker's provider never sends the predicate, so a box
                 still holding a value would read as a filter that is on. What it CAN narrow by is
                 named instead, since the alternative is a hunt over every open issue. -->
            <p v-else class="text-xs text-amber-400">
              {{ t('bugHunt.issueTypeUnsupported', { tracker: descriptor?.label ?? '' }) }}
            </p>
          </UFormField>

          <UFormField :label="t('bugHunt.labels')" :help="t('bugHunt.labelsHelp')">
            <UInput v-model="labels" placeholder="regression, checkout" class="w-full" />
          </UFormField>
        </div>

        <!-- Where an adopted bug lands, and on a repo-backed tracker WHICH REPOSITORY is
             scanned, so the wording says both rather than leaving the scope unexplained. Stated
             when the frame this hunt was opened from is the only legal target; a choice (scoped
             to that frame) when it has modules, or over the whole board when the hunt was opened
             standalone. -->
        <!-- Two blocks rather than one with a computed `keypath`: the i18n extractor reads a
             bound keypath as the key itself, so a dynamic one is a key missing from every
             locale. Every other `<i18n-t>` in the SPA names its key statically for that reason. -->
        <p v-if="containerStated" class="text-xs text-slate-400">
          <i18n-t v-if="boardFromService" keypath="bugHunt.huntingIn" tag="span" scope="global">
            <template #container>
              <span class="font-medium text-slate-200">{{ pinnedContainer!.title }}</span>
            </template>
          </i18n-t>
          <i18n-t v-else keypath="bugHunt.adoptingInto" tag="span" scope="global">
            <template #container>
              <span class="font-medium text-slate-200">{{ pinnedContainer!.title }}</span>
            </template>
          </i18n-t>
        </p>
        <!-- Two fields rather than one with a computed key, for the reason the two blocks above
             are two: the i18n extractor reads a bound key as the key itself, so a dynamic one
             leaves BOTH real keys unreferenced and a dead-key sweep prunes them. -->
        <UFormField v-else-if="boardFromService" :label="t('bugHunt.huntIn')">
          <USelect v-model="containerId" :items="containerItems" class="w-full" />
        </UFormField>
        <UFormField v-else :label="t('bugHunt.adoptInto')">
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
            <!-- The board the scan actually ran against, named because on a repo-backed tracker
                 the platform resolved it: the person reading the shortlist should not have to
                 infer which repository it came out of. -->
            <span class="text-slate-500">
              {{ t('bugHunt.scannedBoard', { board: hunt.result!.board }) }}
            </span>
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
                    rel="noopener noreferrer"
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
                  <span v-if="createdAtDate(candidate.createdAt)">
                    {{ d(createdAtDate(candidate.createdAt)!, 'short') }}
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
