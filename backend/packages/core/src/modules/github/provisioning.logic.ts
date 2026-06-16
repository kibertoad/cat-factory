import type { InstallationPermissions } from '../../ports/github-provisioning'

// Pure capability logic for the two-App provisioning model (ADR 0005). No I/O —
// just the rule for whether a token may create a repo, so it's trivially
// unit-testable and shared between the worker adapter and any future caller.
//
// Which App a workspace uses is decided per *installation* (the App that owns it,
// recorded on the binding), not by an org allow-list — see GitHubAppRegistry.

/**
 * Whether a token with these granted permissions may create a repository.
 * `POST /orgs/{org}/repos` requires repository `Administration: write`, which the
 * granted-permissions map reports as `administration: 'write'`. This is the
 * *proactive* guard so we avoid a round trip that is certain to 403; callers
 * should still treat a live 403 as authoritative, since org policies can block
 * even a correctly-permissioned App.
 */
export function canCreateRepo(permissions: InstallationPermissions): boolean {
  return permissions.administration === 'write'
}
