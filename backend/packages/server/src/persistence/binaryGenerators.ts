import type { ApiContractDocument } from '@cat-factory/contracts'
import type { BinaryGeneratorSource, BinaryGeneratorView } from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'

// The client half of the mothership-mode generative-integration read (see
// `../modules/binaryGenerators/BinaryGeneratorsController.ts` for why the registry crosses the
// machine API at all). A mothership-mode node resolves a step's `generatorIds` against the
// mothership's registry instead of its own, so the set the pipeline builder OFFERED and the set
// admission RESOLVES are the same set however far behind the node's build has drifted.

/**
 * A {@link BinaryGeneratorSource} backed by the mothership's `GET /internal/binary-generators`
 * (+ `POST .../contracts`), presenting the node's machine token.
 *
 * **A failed read THROWS; it never degrades to an empty registry.** "The mothership is
 * unreachable" and "this deployment registers no integrations" are the same value and opposite
 * facts, and unlike the estate's case the second one is ADMISSION policy: an empty set refuses
 * every generator-selecting step with `unknown_generator`, which is a false configuration error
 * reported against a correctly configured step — the exact misattribution this whole seam exists
 * to remove. That covers every way the read can fail to produce the set: a transport error, a
 * refusal, a 404 from a mothership older than this node, and a 200 whose payload this client
 * cannot read.
 *
 * Throwing is NOT the same as failing the run, and each caller decides what it means for it.
 * Admission converts it into `binary_generators_unavailable` (503-shaped and retryable, kept
 * deliberately apart from `binary_output_generator_invalid`); the dispatch brief keeps its
 * best-effort disposition and injects nothing, which the trait guidance already defines as "the
 * platform could not provide storage — do not attempt any upload; report it"; the workspace
 * snapshot marks the picker unreadable rather than empty. What this class guarantees is that the
 * gap is never spelled as a registry that holds nothing.
 *
 * **On what the reply is trusted to name.** A definition carries its credential's KEY NAME, and
 * this node resolves that key against its OWN environment before the value rides a job body into
 * an agent process. That is a real widening of `createEnvToolSecretResolver`'s default over the
 * standalone case, where the key was named by code this process itself runs — but not a new
 * grant: a mothership already supplies the pipelines, prompts and repo targets of every run this
 * node executes, so it can already reach the laptop's environment through any agent it dispatches.
 * The lever for a deployment that wants the narrower boundary anyway (or simply wants a
 * mis-declared key to fail loudly instead of siphoning a developer's own token) is
 * `EnvToolSecretResolverOptions.allowKeys`, which gates this subject family too.
 *
 * There is no cache here on purpose, for the reason its sibling gives: the reads are already
 * bounded by the callers in front of them, and the set changes only when the mothership is
 * redeployed — a second TTL'd copy with no invalidation path is exactly the homebrew cache the
 * caching seam exists to keep out.
 */
export class HttpBinaryGeneratorSource implements BinaryGeneratorSource {
  constructor(
    private readonly opts: {
      baseUrl: string
      /**
       * The machine token to present, as a fixed string OR a provider read PER REQUEST — the
       * same shape `HttpPersistenceRpcClient` takes, so a token cached after boot by the
       * `/local/mothership/connect` login is picked up without a restart.
       */
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async views(): Promise<BinaryGeneratorView[]> {
    const body = await this.read<{ generators?: unknown }>('/internal/binary-generators')
    // Shape-checked rather than cast, for the same reason every other failure here throws: a
    // reply this code cannot read is a reply whose registered set is unknown, and the one
    // disposition that must never be reachable is answering an unknown set with an empty one. A
    // missing `generators` key is exactly as unreadable as a malformed one — an empty registry
    // is spelled `[]`, which no honest server omits.
    if (!Array.isArray(body.generators)) throw unreadable('generators')
    return body.generators as BinaryGeneratorView[]
  }

  async documentsFor(ids: string[]): Promise<Map<string, ApiContractDocument[]>> {
    if (ids.length === 0) return new Map()
    const body = await this.read<{ documents?: unknown }>('/internal/binary-generators/contracts', {
      ids,
    })
    const documents = body.documents
    if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
      throw unreadable('documents')
    }
    return new Map(Object.entries(documents as Record<string, ApiContractDocument[]>))
  }

  private async read<T>(path: string, payload?: unknown): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`
    // The batched contract read carries a LIST, so it is a POST — the same reason the
    // persistence RPC is one. Both are reads; neither is cacheable over the machine API.
    const init: RequestInit = payload
      ? {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      : { headers: { authorization: `Bearer ${token ?? ''}` } }
    let res: Response
    try {
      res = await fetchImpl(url, init)
    } catch (error) {
      // A transport failure is reported as the outage it is. The message names the set rather
      // than the URL, which carries no secret here but would be noise in an operator's log.
      throw new UnavailableError(
        'The deployment’s generative integrations could not be read from the mothership',
        'binary_generators_unreachable',
        // Scrubbed through `redactSecrets` — a fetch failure routinely echoes the request URL,
        // which here carries the mothership's address.
        describeError(error),
      )
    }
    if (!res.ok) {
      // Includes the case that matters most: a mothership OLDER than this node, which answers
      // 404 for a route it does not serve. Reading that as "no registered integrations" would
      // refuse every generator-selecting step as misconfigured for the duration of a rollback.
      throw new UnavailableError(
        'The mothership refused the generative-integration read',
        'binary_generators_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as T | null
    if (!body || typeof body !== 'object') throw unreadable('body')
    return body
  }
}

/**
 * The unreadable-reply refusal, shared by the envelope check and the two payload checks.
 *
 * One helper rather than three literals because they are one FACT — the mothership answered with
 * something this node cannot resolve a selection against — and the whole point of this class is
 * that every route to "we do not know what is registered" ends at a throw. `field` names which
 * part failed, so an operator can tell a malformed body from a route answering a different shape.
 */
function unreadable(field: string): UnavailableError {
  return new UnavailableError(
    'The mothership returned an unreadable generative-integration set',
    'binary_generators_unreachable',
    { field },
  )
}
