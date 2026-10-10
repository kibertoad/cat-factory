import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AssistantAnswer, AssistantCapability, AssistantTurn } from '~/types/domain'
import type { LoadState } from '~/types/load-state'
import { useWorkspaceStore } from '~/stores/workspace'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'

/**
 * How long the capability read waits before it counts as failed.
 *
 * The shared client sets no timeout, so a connection that is accepted and never answered (a proxy
 * holding it open, a wedged worker) leaves the GET pending for ever. Without a deadline that is a
 * modal whose read never settles: no answer, no failure, and therefore no retry either, since the
 * retry lives in what a FAILED read puts on screen. The read itself is a tiny in-memory answer on
 * the backend, so anything past a few seconds is already a connection that is not coming back.
 */
const CAPABILITY_DEADLINE_MS = 10_000

/**
 * In-app assistant state: what this deployment's assistant can do, and the last turn's outcome.
 *
 * Nothing is persisted server-side and nothing accumulates here: a turn is one prompt and one
 * outcome, and the board itself is where the result lives afterwards (the write arrives over the
 * live stream like any other, so the frame or task shows up without this store touching the board).
 * Keeping a transcript would be a second, staler record of changes the board already carries.
 *
 * Failures of a TURN are not held here: every refusal a turn can raise is a `DomainError` the
 * shared error funnel (`usePipelineErrorToast`) already renders translated, copyable and with its
 * request id. The three OUTCOMES are the ones this store keeps, because they are answers rather
 * than errors. A failed capability READ is the exception, and it is state rather than a throw: see
 * `loadCapability`.
 */
export const useAssistantStore = defineStore('assistant', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const capability = ref<AssistantCapability | null>(null)
  const capabilityRead = ref<LoadState>('idle')
  const turn = ref<AssistantTurn | null>(null)
  const running = ref(false)

  /**
   * How many reads have STARTED. Compared before every write, so two overlapping reads settle in
   * the order they were ISSUED rather than the order they answer: a slow success that lands after
   * the fast failure that superseded it would otherwise re-offer the box on the older answer.
   */
  let reads = 0

  /** Whether a model is wired at all. Only meaningful once `capabilityRead` says `ready`. */
  const available = computed(() => capability.value?.available === true)
  const actions = computed(() => capability.value?.actions ?? [])

  /**
   * Read what the assistant can do here. Idempotent: re-reading replaces the answer.
   *
   * A re-read KEEPS the answer it already has while it is in flight, so the surface stays on the
   * fact it can already state instead of dropping back to a spinner every time the modal is
   * re-opened. Only a failure clears it, because a deployment's model may have gone away with
   * whatever took the endpoint down.
   *
   * The failure is recorded, not thrown. It is reported in place: `error` is what puts the
   * explanation and the retry button on screen, and toasting it as well would stack a second,
   * non-dismissing copy of the same sentence over the panel that already says it, once per retry.
   */
  async function loadCapability(): Promise<void> {
    const read = ++reads
    capabilityRead.value = 'loading'
    try {
      const answer = await withDeadline((signal) =>
        api.getAssistantCapability(workspace.requireId(), signal),
      )
      if (read !== reads) return
      capability.value = answer
      capabilityRead.value = 'ready'
    } catch {
      if (read !== reads) return
      capability.value = null
      capabilityRead.value = 'error'
    }
  }

  /** Read under {@link CAPABILITY_DEADLINE_MS}, ABORTING the request when it expires. */
  async function withDeadline(
    send: (signal: AbortSignal) => Promise<AssistantCapability>,
  ): Promise<AssistantCapability> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<AssistantCapability>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Assistant capability read timed out after ${CAPABILITY_DEADLINE_MS}ms`))
        }, CAPABILITY_DEADLINE_MS)
        send(controller.signal).then(resolve, reject)
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Run one turn. Throws on a refusal so the caller can hand it to the error funnel; the three
   * outcomes (performed / needs_input / declined) come back as the resolved value, and `null`
   * when the person cancelled the credential prompt.
   */
  async function run(prompt: string): Promise<AssistantTurn | null> {
    // Through the credential flow, exactly as a run start goes: the turn resolves the workspace's
    // OWN preset, so on a workspace pinned to an individual-usage subscription the first turn 428s,
    // the modal collects the password, and it rides transparently from the cache after that.
    //
    // `null` for a CANCELLED prompt, the shape every gated surface here uses. A cancel is not a
    // failed turn and not a declined one either: nothing ran, so there is no outcome to render and
    // nothing to report. `record` never runs, so the kept `turn` is whatever it already was, which
    // for the modal is nothing: editing the prompt cleared it before submit.
    //
    // The completed turn is captured in a local of its OWN name rather than read back off the
    // store's `turn` ref, which this would otherwise shadow: two bindings spelled the same in one
    // function is how a later edit writes to the wrong one with nothing failing.
    const personal = usePersonalSubscriptionsStore()
    let completed: AssistantTurn | null = null
    const ran = await personal.withCredential(async (password) => {
      completed = await record(() => api.runAssistantTurn(workspace.requireId(), prompt, password))
    })
    return ran ? completed : null
  }

  /**
   * Answer the question the last turn asked, by re-running its action with the chosen value in the
   * field it named. Same outcomes, same funnel, and no model call.
   */
  async function answer(chosen: AssistantAnswer): Promise<AssistantTurn> {
    return record(() => api.answerAssistantTurn(workspace.requireId(), chosen))
  }

  /** The half both turns share: hold `running`, keep the outcome, let a refusal through. */
  async function record(send: () => Promise<AssistantTurn>): Promise<AssistantTurn> {
    running.value = true
    try {
      const result = await send()
      turn.value = result
      return result
    } finally {
      running.value = false
    }
  }

  /** Forget the last outcome (the modal closing, or a fresh prompt being typed). */
  function reset(): void {
    turn.value = null
  }

  return {
    capability,
    capabilityRead,
    turn,
    running,
    available,
    actions,
    loadCapability,
    run,
    answer,
    reset,
  }
})
