// Shared validation + safe-serving helpers for binary-artifact images (UI screenshots +
// reference design images). Used by BOTH the workspace-scoped upload/serve controller and
// the container-token-authed harness ingest route, so the security posture can't drift
// between the two entry points.

/**
 * The ONLY content types a binary artifact may carry. Screenshots are PNGs and reference
 * designs are uploaded images; anything else (HTML, SVG — which can carry script and would
 * execute when served inline same-origin) is rejected at the write boundary so the blob
 * endpoint can never become a stored-XSS vector. SVG is deliberately excluded.
 */
export const ALLOWED_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** A hard ceiling on a single artifact's bytes, enforced at every ingest point. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

/**
 * Canonicalise a client-supplied content type to one of {@link ALLOWED_IMAGE_CONTENT_TYPES},
 * or `null` when it isn't an allowed image type. Strips any `; charset=…` parameter and
 * lower-cases before matching.
 */
export function normalizeImageContentType(raw: string | null | undefined): string | null {
  if (!raw) return null
  const base = raw.split(';', 1)[0]!.trim().toLowerCase()
  return ALLOWED_IMAGE_CONTENT_TYPES.has(base) ? base : null
}

/**
 * Headers for serving a stored blob back. We clamp the Content-Type to the allow-list (so
 * a row that somehow holds a non-image type is served as an inert download, never inline
 * active content) and always send `X-Content-Type-Options: nosniff` so a browser can't
 * MIME-sniff the bytes into something executable.
 */
export function blobResponseHeaders(storedContentType: string): Record<string, string> {
  const safe = normalizeImageContentType(storedContentType)
  return safe
    ? {
        'Content-Type': safe,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      }
    : {
        // Not a recognised image: serve as an opaque attachment so nothing executes.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      }
}
