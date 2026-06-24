import type { UrlSafetyPolicy } from '@cat-factory/kernel'

// Derive a URL/host safety policy from ONE integration's config slice (the
// environment-provisioning OR the runner-pool config — never the two merged). Each
// integration fetches operator-supplied URLs and is scoped independently: widening one
// (`allowUrlHosts` / `allowHttpUrls`) MUST NOT widen the other's SSRF guard, so each
// resolves its own policy from its own slice. The strict public-https default still
// applies to every host/scheme not explicitly exempted. Returns undefined when nothing
// is widened, so callers leave the integration on its strict built-in default.

/** The per-integration config fields that widen the strict URL/host guard. */
export interface UrlSafetyConfigSlice {
  allowUrlHosts?: string[]
  allowHttpUrls?: boolean
}

export function resolveUrlSafetyPolicy(slice: UrlSafetyConfigSlice): UrlSafetyPolicy | undefined {
  const hosts = [...new Set((slice.allowUrlHosts ?? []).map((h) => h.trim()).filter(Boolean))]
  const allowHttp = Boolean(slice.allowHttpUrls)
  if (hosts.length === 0 && !allowHttp) return undefined
  return {
    schemes: allowHttp ? ['https', 'http'] : ['https'],
    allowHosts: hosts,
  }
}
