import { computed, ref } from 'vue'
import { defaultBuildPipelineId } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { composeRunOutcome, hasOutcomeToShow } from '~/utils/runOutcome'

/**
 * What a task offers a human to DO, and the handlers that do it.
 *
 * Shared by the two surfaces that put a task's action within one click: the board's task card
 * and the queue's card. Both must offer the same Start (same pipeline), the same Resolve (same
 * gate) and the same Merge (same confirm), or a reader would learn two products.
 */
export function useTaskActions(taskId: () => string) {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const ui = useUiStore()
  const reviews = useReviewStage()
  const toast = useToast()
  const { t } = useI18n()
  const { confirm } = useConfirm()

  const task = computed<Block | undefined>(() => board.getBlock(taskId()))

  // This Start is a ONE-TAP live start, so it has nothing to ask for and offers no dry-run
  // request. What it does owe the reader is the half that is not a choice: a preset that sandboxes
  // their role means this button opens a pull request and merges nothing, and a card that said so
  // only after the fact would leave that to be discovered from a run that stops at the merge.
  const { forcedFor } = useDryRunPolicy()
  const sandboxed = computed(() => forcedFor(taskId()))

  /** Deps that haven't merged yet: these block this task from running. */
  const unmet = computed(() => board.unmetDeps(taskId()))
  const runnable = computed(() => board.isRunnable(taskId()))

  const pipelineFor = useStartPipelineResolver()
  const defaultPipeline = computed(() => pipelineFor(task.value))

  /**
   * Whether the outcome summary has something to show, asked of the SAME reduction the window
   * renders and the inspector's button gates on: a surface that offered "read the result" on a
   * task whose every section says "nothing here" would teach people the surface is empty. A task
   * marked done by hand, with no pull request and no run, is that task.
   */
  const outcomeReadable = computed(() => {
    const block = task.value
    if (!block) return false
    return hasOutcomeToShow(
      composeRunOutcome({ block, instance: execution.getInstance(block.executionId) ?? null }),
    )
  })

  function openOutcome() {
    ui.openOutcome(taskId(), task.value?.executionId ?? null)
  }

  // Optimistic "Start": flip the button into a spinning "Starting…" state the instant it's
  // clicked, before the server confirms. The button naturally unmounts once the stream pushes the
  // block into `in_progress`; if the start call faults we revert and surface a toast.
  const starting = ref(false)

  async function start() {
    if (!runnable.value) {
      toast.add({
        title: t('board.task.blockedByDependenciesTitle'),
        description: t('board.task.waitingOn', {
          deps: unmet.value.map((d) => d.title).join(', '),
        }),
        icon: 'i-lucide-lock',
      })
      return
    }
    const pipeline = defaultPipeline.value
    if (!pipeline) {
      toast.add({
        title: t('board.task.noPipelineTitle'),
        description: t('board.task.noPipelineBody'),
      })
      return
    }
    starting.value = true
    // false ⇒ the run never started (the user cancelled the personal-password prompt, or the
    // start was refused: the store surfaces the actionable toast itself). Revert the optimistic
    // state; on success the button unmounts once the stream pushes in_progress.
    const started = await execution.start(taskId(), pipeline)
    if (started) {
      // Confirm the (optimistic) start landed: the button unmounts once the stream pushes
      // in_progress, so without this the successful action gives no feedback. A sandboxed start
      // says so here rather than borrowing the live wording: this is the moment the reader learns
      // what they just started, and the two runs differ in what they will end up doing.
      toast.add({
        title: sandboxed.value ? t('board.dryRunToast.title') : t('board.task.startedToast.title'),
        description: sandboxed.value
          ? t('board.dryRunToast.body', { name: pipeline.name })
          : t('board.task.startedToast.body', { name: pipeline.name }),
        color: sandboxed.value ? 'warning' : 'success',
        icon: sandboxed.value ? 'i-lucide-shield' : 'i-lucide-play',
      })
    } else {
      starting.value = false
    }
  }

  async function merge() {
    // Merging a PR into its base is consequential and effectively irreversible: gate it behind a
    // confirm (plain, not the destructive shape). `execution.mergePr` surfaces its own error toast.
    const ok = await confirm({
      title: t('board.task.mergeConfirm.title'),
      description: t('board.task.mergeConfirm.body'),
      confirmLabel: t('board.task.mergeConfirm.confirm'),
      icon: 'i-lucide-git-merge',
    })
    if (!ok) return
    await execution.mergePr(taskId())
  }

  // A `blocked` task is waiting on a human for one of two reasons, an agent-raised decision OR an
  // approval gate, and both must surface (a failed run is shown separately by the
  // AgentFailureCard). Read off the per-block index rather than scanning the workspace-wide list:
  // this computed is mounted once per card and invalidated by every execution event.
  const pendingDecision = computed(() => execution.decisionsByBlock.get(taskId())?.[0])
  // The async stage an iterative reviewer gate (requirements-review / clarity-review) is mid-cycle
  // in (folding the answers, then re-reviewing), or null. While set, the gate needs NO human
  // action, so its approval is suppressed below and a working indicator shows instead.
  const reviewStage = computed(() => reviews.stageForBlock(taskId()))
  const reviewStageLabel = computed(() =>
    reviewStage.value === 'incorporating'
      ? t('board.task.incorporatingAnswers')
      : reviewStage.value === 'reviewing'
        ? t('board.task.reReviewing')
        : reviewStage.value === 'recommending'
          ? t('board.task.recommending')
          : null,
  )
  const pendingApproval = computed(() => {
    const a = execution.approvalsByBlock.get(taskId())?.[0]
    // A reviewer gate whose review is incorporating / re-reviewing in the driver is doing
    // background work, not awaiting a human: don't surface it as "Approval needed".
    if (a && reviews.isBackground(a.agentKind, taskId())) return undefined
    return a
  })

  /**
   * What this blocked task actually needs from a human: drives the card's label, pulse and
   * action. Decision takes precedence over approval (a step never holds both at once; this is
   * just a stable order). Null when nothing is pending.
   */
  const attention = computed<{
    label: string
    icon: string
    action: string
    open: () => void
  } | null>(() => {
    const d = pendingDecision.value
    if (d)
      return {
        label: t('board.task.decisionNeeded'),
        icon: 'i-lucide-circle-help',
        action: t('board.task.resolve'),
        open: () => ui.openDecision(d.instanceId, d.decision.id),
      }
    const a = pendingApproval.value
    if (a)
      return {
        label: t('board.task.approvalNeeded'),
        icon: 'i-lucide-shield-check',
        action: t('board.task.approve'),
        open: () => ui.openApprovalDetail(a.instanceId, a.approval.id),
      }
    return null
  })

  return {
    task,
    sandboxed,
    unmet,
    runnable,
    defaultPipeline,
    outcomeReadable,
    openOutcome,
    starting,
    start,
    merge,
    pendingDecision,
    reviewStage,
    reviewStageLabel,
    attention,
  }
}

/** The pipeline a plain "Start" runs, as the descriptor `execution.start` takes. */
export interface StartPipeline {
  id: string
  name: string
}

/**
 * Resolve the pipeline a plain "Start" uses for a task. A function rather than a computed so
 * the intake dialog can ask it about a task it has just created, and the cards about their own.
 */
export function useStartPipelineResolver() {
  const pipelines = usePipelinesStore()
  const uiMode = useUiModeStore()
  const { t } = useI18n()

  /**
   * The pipeline a plain "Start" will use: the task's pinned pipeline, else the build rung this
   * INTERFACE MODE defaults to (`defaultBuildPipelineId`: the fixed Standard build in basic mode,
   * the Adaptive one in advanced). The workspace's positional first pipeline remains the last
   * resort, for a board whose catalog does not carry the rung (an older seed, or a deployment that
   * retired it).
   *
   * A PIN is honoured even when the library holds no row for it, and that branch is the whole reason
   * this returns a descriptor rather than a `Pipeline`. An INTERNAL pipeline is withheld from the
   * library on purpose (the platform starts it on its own behalf, so no picker may offer it), and a
   * task can legitimately be pinned to one: the docs-refresh preset spawns its tasks onto
   * `pl_code_comments`. Resolving that pin through the library alone answers undefined, and the
   * fallback below then starts a FULL BUILD on a comment-only task while the button still reads as
   * an ordinary Start. The fallback chain exists for a task with NO pin; a pin the library cannot
   * show is still the task's answer, and the backend resolves the id for the run.
   */
  return (task: Pick<Block, 'pipelineId'> | undefined): StartPipeline | undefined => {
    const pinnedId = task?.pipelineId
    if (pinnedId) {
      return (
        pipelines.getPipeline(pinnedId) ?? {
          id: pinnedId,
          // The catalog NAME map spans the whole catalog (unlike the versions map), so an internal
          // pin still names itself here; the generic label covers a pin to something this build's
          // catalog does not know at all.
          name: pipelines.catalogNames[pinnedId] ?? t('board.task.pipelineFallback'),
        }
      )
    }
    // No pin: the workspace's own DECLARED in-app default outranks the interface-mode rung, because
    // an operator who named one said something a tier cannot overrule.
    const declared = pipelines.declaredDefaultId('interactive')
    return (
      pipelines.getPipeline(declared ?? defaultBuildPipelineId(uiMode.isAdvanced)) ??
      pipelines.pipelines[0]
    )
  }
}
