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
 * BOTH projections ride one response, so a call for either resolves the other's half from the same
 * read and the two cannot disagree within one operation.
 *
 * There is no cache here on purpose, the same answer its two siblings give. `all()` is called once
 * per miss of the per-workspace catalog cache that already sits in front of it, and
 * `defaultFragmentIdsFor` once per task creation, so the call volume is bounded by that cache
 * rather than by traffic. The memo this class shipped with was worse than a TTL'd copy: it was
 * held for the PROCESS lifetime with no invalidation path, so an operator who added an org standard
 * and redeployed the mothership reached every already-running node only by restarting it. A second
 * copy of a value with no way to invalidate it is exactly the homebrew cache the caching seam
 * exists to keep out.
 */
export class HttpPromptFragmentSource implements PromptFragmentSource {
  /** The pool lives on the mothership, so nothing in THIS process may be judged as if it were it. */
  readonly inProcess = false

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
    return (await this.read()).fragments
  }

  async defaultFragmentIdsFor(taskType: TaskType): Promise<string[]> {
    return (await this.read()).taskTypeDefaults[taskType] ?? []
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
    // The VALUES too, not just the container. A default set is spread into the id set a new task is
    // seeded with, so a reply mapping a task type to a bare `"node.style"` seeds ten single-character
    // ids rather than one fragment: silent, and exactly the "the pool is unknown" case above, since
    // a payload this client cannot read is one whose defaults it does not know.
    if (
      !Object.values(defaults).every(
        (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
      )
    ) {
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
