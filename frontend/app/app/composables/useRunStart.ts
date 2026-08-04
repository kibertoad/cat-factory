import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { dryRunForcedForRole, type RunMode } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useUiModeStore } from '~/stores/uiMode'

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
 *
 * `dryRunForcedForRole` is the contracts rule the engine applies at admission, not a restated
 * `includes`: reading the role's absence (auth-disabled dev, where the SPA resolves no role) is
 * the part that has to agree, since guessing a tier there would sandbox a whole deployment.
 */
export function useRunStart(blockId: MaybeRefOrGetter<string | undefined>) {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const riskPolicies = useRiskPoliciesStore()
  const uiMode = useUiModeStore()
  const access = useWorkspaceAccess()

  /** The caller's own explicit ask for this block, reset once a run has been started with it. */
  const requested = ref(false)

  /**
   * The preset that governs this task's merge decision: its own, else the workspace default
   * (the same resolution the engine makes, via the store).
   */
  const preset = computed(() => {
    const block = board.getBlock(toValue(blockId) ?? '')
    return riskPolicies.resolve(block?.riskPolicyId)
  })

  /** This preset sandboxes runs started by the signed-in user's role, whatever they ask for. */
  const forced = computed(() => dryRunForcedForRole(preset.value?.dryRunRoles, access.role.value))

  /** Whether to offer the request control at all: nothing to ask for once policy decided it. */
  const canRequest = computed(() => uiMode.isAdvanced && !forced.value)

  /** What the run WILL be, for a control that describes the start it is about to make. */
  const dryRun = computed(() => forced.value || requested.value)

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
