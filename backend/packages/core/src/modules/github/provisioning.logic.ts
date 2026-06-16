import type { InstallationPermissions } from '../../ports/github-provisioning'

// Pure decision logic for the two-App provisioning model (ADR 0005). No I/O —
// just the tier and capability rules, so they're trivially unit-testable and
// shared between the worker adapter and any future caller.

/**
 * Which App registration's credentials to use for an org. `privileged` is the
 * App that carries `Administration: write` and can create repositories
 * directly; `restricted` is the minimal-permission App used for sensitive orgs,
 * where direct creation is intentionally unavailable and a fallback path is
 * taken instead. Two separate App registrations are required because a single
 * App has one permission set across every installation — see ADR 0005.
 */
export type AppTier = 'privileged' | 'restricted'

export interface TierConfig {
  /**
   * Org logins (matched case-insensitively) explicitly allowed to use the
   * privileged App. Anything not listed resolves to `restricted`.
   */
  privilegedOrgs: readonly string[]
}

/**
 * Resolve the App tier for an org. Fails closed: an org is privileged only when
 * explicitly listed, so a missing or mistyped entry degrades to `restricted`
 * rather than silently handing out the elevated grant.
 */
export function resolveAppTier(orgLogin: string, config: TierConfig): AppTier {
  const needle = orgLogin.trim().toLowerCase()
  if (needle === '') return 'restricted'
  const privileged = config.privilegedOrgs.some((org) => org.trim().toLowerCase() === needle)
  return privileged ? 'privileged' : 'restricted'
}

/**
 * Whether a token with these granted permissions may create a repository.
 * `POST /orgs/{org}/repos` requires repository `Administration: write`, which
 * the granted-permissions map reports as `administration: 'write'`. This is the
 * *proactive* guard so we avoid a round trip that is certain to 403; callers
 * should still treat a live 403 as authoritative, since org policies can block
 * even a correctly-permissioned App.
 */
export function canCreateRepo(permissions: InstallationPermissions): boolean {
  return permissions.administration === 'write'
}
