import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { dryRunForcedForRole, type RunMode } from '@cat-factory/contracts'
import type { Pipeline, RiskPolicy } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useUiModeStore } from '~/stores/uiMode'

/**
 * Whether this deployment's merge policy sandboxes the signed-in user's runs on a given block:
 * the pipeline works and opens its pull request, and nothing merges.
 *
 * Exposed as FUNCTIONS of a block id rather than as computeds over one, because the start
 * surfaces ask the question in two shapes and both must get the same answer. A control bound to
 * a block (the inspector's Run menu, the focus view's picker) asks about that block and re-asks
 * when the selection moves; the board's drop handler resolves its target at the moment of the
 * drop and has no block to bind to. {@link useRunStart} wraps these for the first shape.
 *
 * `dryRunForcedForRole` is the contracts rule the engine applies at admission, not a restated
 * `includes`: reading the role's absence (auth-disabled dev, where the SPA resolves no role) is
 * the part that has to agree, since guessing a tier there would sandbox a whole deployment.
 */
export function useDryRunPolicy() {
  const board = useBoardStore()
  const riskPolicies = useRiskPoliciesStore()
  const access = useWorkspaceAccess()

  /**
   * The preset that governs this task's merge decision: its own, else the workspace default
   * (the same resolution the engine makes, via the store).
   */
  function presetFor(blockId: string | undefined): RiskPolicy | null {
    return riskPolicies.resolve(board.getBlock(blockId ?? '')?.riskPolicyId)
  }

  /** That preset sandboxes runs started by the signed-in user's role, whatever they ask for. */
  function forcedFor(blockId: string | undefined): boolean {
    return dryRunForcedForRole(presetFor(blockId)?.dryRunRoles, access.role.value)
  }

  return { presetFor, forcedFor }
}

/**
 * The run-mode half of starting a run, shared by every surface that offers a pipeline to start
 * (the inspector's Run menu, the focus view's picker) so the three facts below cannot drift into
 * two answers on two surfaces.
 *
 * A run is either live or a SANDBOX (`dry_run`): the pipeline works and opens its pull request,
 * and nothing merges, at either exit. Two things can put it there, and they are not the same
 * thing to a person reading the control:
 *
 *  - **A request.** The initiator asked for a sandbox on this run. An override of the default,
 *    unset until asked for and never persisted, so it is `advanced`-tier: hiding it leaves
 *    exactly the live run a basic-tier user would otherwise have started.
 *  - **The task's merge preset.** It sandboxes the roles it lists (`dryRunRoles`), and a run
 *    cannot ask its way out of that, which is the whole point of the setting. So it is stated
 *    in BOTH tiers, and it REPLACES the request control rather than sitting beside it: a toggle
 *    over a decision already made would be the concealed-setting failure in reverse.
 */
export function useRunStart(blockId: MaybeRefOrGetter<string | undefined>) {
  const execution = useExecutionStore()
  const uiMode = useUiModeStore()
  const policy = useDryRunPolicy()

  /** The caller's own explicit ask for THIS block. */
  const requested = ref(false)

  const preset = computed(() => policy.presetFor(toValue(blockId)))

  /** This preset sandboxes runs started by the signed-in user's role, whatever they ask for. */
  const forced = computed(() => policy.forcedFor(toValue(blockId)))

  /** Whether to offer the request control at all: nothing to ask for once policy decided it. */
  const canRequest = computed(() => uiMode.isAdvanced && !forced.value)

  /** What the run WILL be, for a control that describes the start it is about to make. */
  const dryRun = computed(() => forced.value || requested.value)

  // The request belongs to the block it was made on, and the surfaces holding it OUTLIVE that
  // block: the inspector is mounted once for the whole session and follows the board selection.
  // Without this, arming a sandbox on one task and then selecting another silently sandboxes the
  // next run started, on a task nobody asked it for. The button's icon is the only tell, and it
  // reads as a property of the task now shown.
  watch(
    () => toValue(blockId),
    () => {
      requested.value = false
    },
  )

  function setRequested(value: boolean) {
    requested.value = value
  }

  /**
   * Start `pipeline` on this block. Only an EXPLICIT request travels: a forced sandbox is the
   * server's own reading of the preset, and re-sending it as a request would file the run's mode
   * under "the initiator asked for this" when they did not, costing the run the advisory that
   * explains a sandbox nobody chose.
   */
  async function start(pipeline: Pipeline): Promise<boolean> {
    const id = toValue(blockId)
    if (!id) return false
    const mode: RunMode | undefined = requested.value ? 'dry_run' : undefined
    const started = await execution.start(id, pipeline, { mode })
    if (started) requested.value = false
    return started
  }

  return { preset, forced, canRequest, dryRun, requested, setRequested, start }
}
