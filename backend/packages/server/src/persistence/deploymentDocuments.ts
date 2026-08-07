import type {
  DeploymentDocumentResolver,
  DocumentContent,
  DocumentSourceKind,
} from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'
import { isDeploymentScopedSource } from '@cat-factory/contracts'
import { documentBodyRefKey } from '../modules/promptFragments/PromptFragmentsInternalController.js'

// The client half of the mothership-mode DEPLOYMENT-scoped document read (see
// `../modules/promptFragments/PromptFragmentsInternalController.ts` for why the body crosses the
// machine API rather than the credential). The sibling of `promptFragments.ts` and
// `foundationalBuiltins.ts`, written to the same contract for the same reason.

/**
 * A {@link DeploymentDocumentResolver} backed by the mothership's
 * `POST /internal/prompt-fragments/document-bodies`, presenting the node's machine token.
 *
 * **The credential never crosses; the BODY does.** The deployment's document credentials live in
 * the mothership's environment, and `ENCRYPTION_KEY`-class configuration does not reach a laptop,
 * so a node cannot authenticate to the vendor itself. That is the same rule that keeps a
 * decrypting repository off the remote route, applied to a resolver instead of a repository.
 *
 * **A failed read THROWS; it never answers "no such document".** An unreachable mothership and a
 * document this deployment cannot resolve are the same value and opposite facts, and the caller
 * (`FragmentLibraryService.resolveDocumentBody`) degrades a THROW to the fragment's registered
 * body with a warning naming the fragment. Answering silently-absent instead would produce the
 * identical prompt with no warning anywhere, which is exactly the stale-standard failure that is
 * indistinguishable from a current one.
 */
export class HttpDeploymentDocumentResolver implements DeploymentDocumentResolver {
  constructor(
    private readonly opts: {
      baseUrl: string
      /** Fixed token, or a provider read PER REQUEST (the shape every other machine client takes). */
      token: string | (() => string | null)
      /**
       * The sources the MOTHERSHIP has configured, as reported at connect time.
       *
       * A node cannot see the mothership's environment, so `configured()` would otherwise have to
       * be a network call, and it is asked on a hot path (per document-backed entry, per catalog
       * resolve) by a caller that only wants to know whether to bother. Absent ⇒ assume every
       * deployment-scopable source may be served and let the read itself decide, which is the safe
       * direction: it costs one round trip that returns nothing, where the opposite would silently
       * skip a document the mothership could have served.
       */
      configuredSources?: readonly DocumentSourceKind[]
      fetchImpl?: typeof fetch
    },
  ) {}

  configured(source: DocumentSourceKind): boolean {
    if (!isDeploymentScopedSource(source)) return false
    return this.opts.configuredSources?.includes(source) ?? true
  }

  async fetch(source: DocumentSourceKind, externalId: string): Promise<DocumentContent> {
    const content = await this.read(source, externalId)
    return {
      externalId,
      title: '',
      url: '',
      body: content.body,
      version: content.version,
    }
  }

  async probeVersion(source: DocumentSourceKind, externalId: string): Promise<string> {
    // The mothership's own resolver caches the body, so this is not the extra fetch it looks
    // like: the node's `documentBodyCache` asks for a version only when its entry enters the
    // refresh window, and the mothership answers from the copy it just verified.
    return (await this.read(source, externalId)).version
  }

  private async read(
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<{ body: string; version: string }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/prompt-fragments/document-bodies`
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ refs: [{ source, externalId }] }),
      })
    } catch (error) {
      throw new UnavailableError(
        'A deployment-scoped document could not be read from the mothership',
        'deployment_document_unreachable',
        // Scrubbed through `redactSecrets`, because a fetch failure routinely echoes the request
        // URL, which here carries the mothership's address.
        describeError(error),
      )
    }
    if (!res.ok) {
      // Includes a mothership OLDER than this node, which answers 404 for a route it does not
      // serve. Reading that as "the document is gone" would silently pin the registered body.
      throw new UnavailableError(
        'The mothership refused a deployment-scoped document read',
        'deployment_document_unreachable',
        { status: res.status },
      )
    }
    const payload = (await res.json().catch(() => null)) as { bodies?: unknown } | null
    const bodies = payload?.bodies
    if (!bodies || typeof bodies !== 'object' || Array.isArray(bodies)) {
      throw new UnavailableError(
        'The mothership returned an unreadable deployment-document reply',
        'deployment_document_unreachable',
        { field: 'bodies' },
      )
    }
    // Indexed with the SERVER's own key function, never a locally re-spelled one: the pair
    // `(source, externalId)` is what identifies a document, and a client that rebuilds that
    // string itself is one rename away from silently indexing nothing.
    const entry = (bodies as Record<string, unknown>)[documentBodyRefKey(source, externalId)]
    const body = (entry as { body?: unknown } | undefined)?.body
    const version = (entry as { version?: unknown } | undefined)?.version
    if (typeof body !== 'string' || typeof version !== 'string') {
      // ABSENT means the mothership could not resolve it either (it omits rather than failing the
      // whole batch, and logs why on its own side). Throwing keeps the node's disposition the same
      // as a standalone deployment's: degrade to the registered body AND say so.
      throw new UnavailableError(
        'The mothership could not resolve this deployment-scoped document',
        'deployment_document_unresolved',
        { source },
      )
    }
    return { body, version }
  }
}
