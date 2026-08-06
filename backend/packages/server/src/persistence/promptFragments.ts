import type { PromptFragment, TaskType } from '@cat-factory/contracts'
import type { PromptFragmentSource } from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'

// The client half of the mothership-mode prompt-fragment pool read (see
// `../modules/promptFragments/PromptFragmentsInternalController.ts` for why the pool crosses the
// machine API at all). The sibling of `foundationalBuiltins.ts` and `binaryGenerators.ts`, written
// to the same contract for the same reason.

/**
 * A {@link PromptFragmentSource} backed by the mothership's `GET /internal/prompt-fragments`,
 * presenting the node's machine token.
 *
 * **A failed read THROWS; it never degrades to an empty pool.** "The mothership is unreachable" and
 * "this deployment registers no standards" are the same value and opposite facts, and only one of
 * them may reach an agent: an empty pool silently produces work judged against nothing, which is
 * the failure this seam exists to prevent. That covers every way the read can fail to produce a
 * pool: a transport error, a refusal, a 404 from a mothership older than this node, and a 200
 * whose payload this client cannot read.
 *
 * Throwing is not the same as failing the run, and the caller decides which it becomes.
 * `FragmentLibraryService.loadCatalog` lets it propagate (the pool is the tier every other tier
 * merges onto, so a short catalog is not a degraded answer, it is a wrong one), while a task
 * CREATION propagates it too, being a user action that can be retried.
 *
 * BOTH projections ride one response, so `defaultFragmentIdsFor` costs no second round-trip and
 * the two halves cannot answer from different reads of a redeploying mothership. The response is
 * memoised for the process lifetime after the first successful read: the pool is CODE on the
 * mothership, so it changes only when the mothership is redeployed, and re-reading it per catalog
 * miss would put a network hop under the per-workspace cache that already sits in front of this.
 * A FAILED read is never memoised, so an outage does not pin this node to a permanent throw.
 */
export class HttpPromptFragmentSource implements PromptFragmentSource {
  private cached: Promise<PoolPayload> | null = null

  constructor(
    private readonly opts: {
      baseUrl: string
      /**
       * The machine token to present, as a fixed string OR a provider read PER REQUEST, the same
       * shape `HttpPersistenceRpcClient` takes, so a token cached after boot by the
       * `/local/mothership/connect` login is picked up without a restart.
       */
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async all(): Promise<PromptFragment[]> {
    return (await this.pool()).fragments
  }

  async defaultFragmentIdsFor(taskType: TaskType): Promise<string[]> {
    return (await this.pool()).taskTypeDefaults[taskType] ?? []
  }

  private pool(): Promise<PoolPayload> {
    if (this.cached) return this.cached
    const pending = this.read().catch((error: unknown) => {
      // Drop the memo on failure BEFORE rethrowing, so a mothership that comes back is read again.
      // Memoising a rejected promise would turn one blip into a node that never resolves a standard
      // until it is restarted.
      this.cached = null
      throw error
    })
    this.cached = pending
    return pending
  }

  private async read(): Promise<PoolPayload> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/prompt-fragments`
    let res: Response
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token ?? ''}` } })
    } catch (error) {
      throw new UnavailableError(
        'The prompt-fragment pool could not be read from the mothership',
        'prompt_fragments_unreachable',
        // Scrubbed through `redactSecrets`, because a fetch failure routinely echoes the request URL,
        // which here carries the mothership's address.
        describeError(error),
      )
    }
    if (!res.ok) {
      // Includes the case that matters most: a mothership OLDER than this node, which answers 404
      // for a route it does not serve. Reading that as "no registered standards" is precisely the
      // silent-empty-pool failure this class refuses to produce.
      throw new UnavailableError(
        'The mothership refused the prompt-fragment pool read',
        'prompt_fragments_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as {
      fragments?: unknown
      taskTypeDefaults?: unknown
    } | null
    // Shape-checked rather than cast, for the same reason every other failure here throws: a reply
    // this code cannot read is a reply whose POOL is unknown, and the one disposition that must
    // never be reachable is answering an unknown pool with an empty one. A missing key is exactly
    // as unreadable as a malformed one. An empty pool is spelled `[]`, which no honest server omits.
    if (!body || !Array.isArray(body.fragments)) throw unreadable('fragments')
    const defaults = body.taskTypeDefaults
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw unreadable('taskTypeDefaults')
    }
    return {
      fragments: body.fragments as PromptFragment[],
      taskTypeDefaults: defaults as Record<string, string[]>,
    }
  }
}

/** Both projections of one read. */
interface PoolPayload {
  fragments: PromptFragment[]
  taskTypeDefaults: Record<string, string[]>
}

/**
 * The unreadable-reply refusal, shared by both payload checks. One helper rather than two literals
 * because they are one FACT (the mothership answered with something this node cannot resolve a
 * pool from), and the whole point of this class is that every route to "we do not know the
 * standards" ends at a throw. `field` names which part failed.
 */
function unreadable(field: string): UnavailableError {
  return new UnavailableError(
    'The mothership returned an unreadable prompt-fragment pool',
    'prompt_fragments_unreachable',
    { field },
  )
}
