import { computed, type ComputedRef, type Ref } from 'vue'
import { isDesignSource } from '@cat-factory/contracts'
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
} from '~/types/domain'

/**
 * How this workspace CONNECTS to a document source, and what it may connect with.
 *
 * Split out of `stores/documents.ts` when the OAuth half landed, because "which credential can
 * this board offer for this source" turned into a question with several parts: a source declares
 * an OAuth half in code, the deployment may or may not have registered an app for it, and the
 * typed-credential form is the fallback either way. The store's other concerns (the imported
 * documents, their freshness, the doc-kind role links) never read any of it.
 *
 * It takes bound accessors rather than the store, so it stays testable on its own and cannot
 * reach for state it has no business in.
 */
export interface DocumentSourceConnectDeps {
  workspaceId: () => string
  /**
   * The sources this DEPLOYMENT can OAuth, as the backend reports them beside the descriptors.
   *
   * Owned by the caller (the probe writes it) rather than fetched here, because it arrives on the
   * same response as the descriptors and a second read would be a second round trip that could
   * disagree with the first.
   */
  oauthSources: Ref<DocumentSourceKind[]>
  /** The connected subset of the descriptors, in registry order. */
  connectedSources: ComputedRef<DocumentSourceDescriptor[]>
  /** Fold a new/updated connection into the caller's list. */
  onConnected: (connection: DocumentConnection) => void
  /** Drop a source's connection from the caller's list. */
  onDisconnected: (source: DocumentSourceKind) => void
}

export function useDocumentSourceConnect(deps: DocumentSourceConnectDeps) {
  const api = useApi()

  /**
   * Whether this deployment can run the OAuth connect for a source RIGHT NOW.
   *
   * Deliberately not `descriptor.oauth !== undefined`: that says the source supports the flow,
   * which is true of Figma on every deployment, including the ones that have registered no app.
   * A button rendered off the descriptor alone could only 503.
   */
  function canConnectWithOAuth(source: DocumentSourceKind): boolean {
    return deps.oauthSources.value.includes(source)
  }

  /**
   * Every CONNECTED design source, in the order the backend registered them.
   *
   * `isDesignSource` comes from contracts rather than a local list, for the reason the backend
   * reads it there: whether a source describes a design is a fact both sides have to agree about,
   * and a second copy here would drift the moment a source is added.
   */
  const connectedDesignSources = computed(() =>
    deps.connectedSources.value.map((s) => s.source).filter(isDesignSource),
  )

  /** Connect the workspace to a source with its credential bag. */
  async function connect(source: DocumentSourceKind, credentials: Record<string, string>) {
    deps.onConnected(await api.connectDocumentSource(deps.workspaceId(), source, credentials))
  }

  /** Disconnect the workspace from a source. */
  async function disconnect(source: DocumentSourceKind) {
    await api.disconnectDocumentSource(deps.workspaceId(), source)
    deps.onDisconnected(source)
  }

  /**
   * Send the browser to a source's vendor consent screen.
   *
   * A full navigation rather than a popup: the vendor lands back on the app's own OAuth callback,
   * which stores the grant and redirects here, so the returning page re-probes and sees the
   * connection. A popup would leave the opener holding stale state with nothing to tell it.
   */
  async function beginOAuthConnect(source: DocumentSourceKind) {
    const { url } = await api.documentSourceOAuthUrl(deps.workspaceId(), source)
    window.location.assign(url)
  }

  return { canConnectWithOAuth, connectedDesignSources, connect, disconnect, beginOAuthConnect }
}
