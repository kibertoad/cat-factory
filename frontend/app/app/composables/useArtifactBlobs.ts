import { reactive } from 'vue'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Per-component cache for resolving stored binary artifacts (screenshots / reference
 * designs) into `<img>`-ready object URLs.
 *
 * The artifact bytes are served behind an authed endpoint (`GET /workspaces/:ws/
 * artifacts/:id/blob`), so the browser can't point an `<img src>` straight at them — they
 * have to be fetched as a `Blob` and turned into an `URL.createObjectURL`. That object URL
 * pins the blob in memory until it's explicitly revoked, so this composable is a FACTORY
 * (one cache per calling component), and the caller MUST `revokeAll()` on unmount. Making
 * it a global singleton would mean one window's unmount frees another window's images.
 *
 * Both the visual-confirmation gate and the test-report window use this, so neither has to
 * own blob plumbing or depend on the other's Pinia store.
 */
export type ArtifactBlobStatus = 'idle' | 'loading' | 'ready' | 'error'

export function useArtifactBlobs() {
  const ws = useWorkspaceStore()
  const api = useApi()

  /** artifactId → object URL (reactive so templates re-render when a blob resolves). */
  const urls = reactive<Record<string, string>>({})
  /**
   * artifactId → the media type the SERVER served these bytes as.
   *
   * The one a surface may decide from. A stored artifact also carries a DECLARED content type,
   * which for an asset is the agent's own claim about the file it uploaded and is optional; the
   * serve path meanwhile clamps anything outside the inline-image list to
   * `application/octet-stream`. So a row deciding picture-versus-file from the declaration gets it
   * wrong in both directions: an undeclared PNG renders as a generic file, and a mis-declared
   * bundle renders as a broken `<img>` with the load reported as successful.
   */
  const types = reactive<Record<string, string>>({})
  /** artifactId → fetch status, drives loading / error / retry affordances. */
  const status = reactive<Record<string, ArtifactBlobStatus>>({})
  /** In-flight promises, so concurrent `resolve(id)` calls share one fetch + one blob. */
  const inFlight = new Map<string, Promise<string | null>>()
  /**
   * Set once `revokeAll()` has run (the owning component unmounted). A fetch already in
   * flight at that point still creates its object URL when it settles; without this guard
   * that URL would be written into the now-cleared cache and never revoked (a leak), and
   * we'd be mutating reactive state for a dead component.
   */
  let disposed = false

  function urlFor(id: string | null | undefined): string | undefined {
    return id ? urls[id] : undefined
  }

  function statusFor(id: string | null | undefined): ArtifactBlobStatus {
    return id ? (status[id] ?? 'idle') : 'idle'
  }

  /** The media type the server served this artifact as, once its bytes are in hand. */
  function typeFor(id: string | null | undefined): string | undefined {
    return id ? types[id] : undefined
  }

  /** Resolve an artifact to an object URL (cached + deduped). Returns null on failure. */
  function resolve(id: string | null | undefined): Promise<string | null> {
    if (!id || disposed) return Promise.resolve(null)
    const cached = urls[id]
    if (cached) return Promise.resolve(cached)
    const pending = inFlight.get(id)
    if (pending) return pending

    status[id] = 'loading'
    const p = api
      .fetchArtifactBlob(ws.requireId(), id)
      .then(({ url, contentType }) => {
        // The owner unmounted while this was in flight: revoke the freshly-minted URL
        // instead of stranding it in the cleared cache.
        if (disposed) {
          try {
            URL.revokeObjectURL(url)
          } catch {
            // Already revoked / unsupported environment, nothing to do.
          }
          return null
        }
        urls[id] = url
        // Written BEFORE the status flips to `ready`, so a watcher reacting to the status never
        // reads a resolved artifact whose served type has not landed yet.
        if (contentType) types[id] = contentType
        status[id] = 'ready'
        return url
      })
      .catch(() => {
        status[id] = 'error'
        return null
      })
      .finally(() => {
        inFlight.delete(id)
      })
    inFlight.set(id, p)
    return p
  }

  /** Force a re-fetch of a previously-failed artifact (clears its cached error state). */
  function retry(id: string): Promise<string | null> {
    const stale = urls[id]
    if (stale) {
      try {
        URL.revokeObjectURL(stale)
      } catch {
        // Already revoked / unsupported environment — nothing to do.
      }
    }
    delete urls[id]
    delete types[id]
    status[id] = 'idle'
    inFlight.delete(id)
    return resolve(id)
  }

  /**
   * Revoke every cached object URL and clear the cache. Call on `onUnmounted` — otherwise
   * the (potentially large) screenshot bytes linger in memory for the session's lifetime.
   */
  function revokeAll(): void {
    disposed = true
    for (const url of Object.values(urls)) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Already revoked / unsupported environment — nothing to do.
      }
    }
    for (const k of Object.keys(urls)) delete urls[k]
    for (const k of Object.keys(types)) delete types[k]
    for (const k of Object.keys(status)) delete status[k]
    inFlight.clear()
  }

  return { urls, types, status, urlFor, statusFor, typeFor, resolve, retry, revokeAll }
}

export type ArtifactBlobs = ReturnType<typeof useArtifactBlobs>
