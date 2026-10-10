import type { ConnectionWarningCode } from '@cat-factory/contracts'

// A connection test can report non-fatal GAPS in the config beside its pass/fail verdict: the
// backend states them as machine-readable codes (it does not localize prose), and the copy the
// operator reads lives here.
//
// The exhaustive `Record<ConnectionWarningCode, …>` is the tier-2 drift guard: a backend that
// adds a warning code fails this typecheck until the SPA has copy for it, which the typed-key
// check alone cannot catch for a runtime-assembled key.

/** Config-gap warning code → i18n key. Leaf keys mirror the code verbatim. */
export const CONNECTION_WARNING_KEYS: Record<ConnectionWarningCode, string> = {
  runner_manifest_no_release:
    'settings.providerConnection.test.warnings.runner_manifest_no_release',
  runner_manifest_no_status_path:
    'settings.providerConnection.test.warnings.runner_manifest_no_status_path',
  github_pat_classic_account_wide:
    'settings.providerConnection.test.warnings.github_pat_classic_account_wide',
  github_pat_scopes_beyond_need:
    'settings.providerConnection.test.warnings.github_pat_scopes_beyond_need',
  github_pat_scope_unreadable:
    'settings.providerConnection.test.warnings.github_pat_scope_unreadable',
  github_pat_no_scopes: 'settings.providerConnection.test.warnings.github_pat_no_scopes',
}
