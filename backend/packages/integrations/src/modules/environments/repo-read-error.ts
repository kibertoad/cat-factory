/**
 * A genuine repository READ fault (not an ordinary "path missing" miss) raised by the
 * checkout-free auto-detectors when a best-effort scan couldn't read the repo at all — the VCS
 * client threw rather than reporting an absent path. The real `RepoFiles` reader converts a 404
 * into `null`/`[]` but THROWS on any other status (401/403 auth or permission, 429/secondary
 * rate limit, 5xx, or a network/token-mint fault), so a thrown read means the detector's result
 * would otherwise be a MISLEADING "nothing found" (or an opaque 500).
 *
 * The detectors keep the reader contract best-effort — a missing path is still `null`/`[]` — but
 * record the first genuine throw and raise this when they detected nothing AND a read faulted.
 * {@link EnvironmentConnectionService} maps it to an actionable `ValidationError` naming the repo
 * and the underlying reason; nothing else should let it escape as a bare 500.
 */
export class RepoReadError extends Error {
  constructor(
    /** The underlying reader error's message (e.g. `GitHub GET …/contents/… → 403: …`). */
    readonly reason: string,
  ) {
    super(reason)
    this.name = 'RepoReadError'
  }
}
