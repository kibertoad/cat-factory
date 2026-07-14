// Policy controlling which URLs an integration may fetch or expose. The default
// (STRICT_URL_SAFETY_POLICY) forbids non-https and every private/internal host,
// which is correct for an untrusted, manifest-described management API supplied by
// an arbitrary workspace. An operator running a TRUSTED in-house adapter (e.g. an
// internal ephemeral-environment platform reachable only on a private/VPN host) can
// widen it via the facade config to permit specific schemes/hosts. Shared by the
// environment-provisioning and runner-pool integrations.

export interface UrlSafetyPolicy {
  /** Permitted URL schemes, lowercased, without the trailing colon (e.g. ['https']). */
  schemes: readonly string[]
  /**
   * Hostnames exempt from the private/internal-host block. Each entry matches the URL
   * hostname case-insensitively: an exact match (`preview.corp`, `10.1.2.3`), or a dot
   * suffix when it starts with `.` (`.internal` matches `a.b.internal`). An exempt host
   * bypasses the loopback / link-local / RFC1918 / `.internal` / `.local` checks. Empty
   * => no exemptions (the strict default).
   */
  allowHosts: readonly string[]
}

/** The default policy: https only, no private/internal hosts, no exemptions. */
export const STRICT_URL_SAFETY_POLICY: UrlSafetyPolicy = {
  schemes: ['https'],
  allowHosts: [],
}
