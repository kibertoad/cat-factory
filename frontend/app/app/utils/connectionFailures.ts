import type { ConnectionFailureCause } from '@cat-factory/contracts'

// A connection test that never got an ANSWER reports the transport failure CLASS as a
// machine-readable `failureCause` (the backend does not localize prose), and the copy the operator
// reads lives here. The backend's own English account of the failure, including the remedy it can
// phrase with the concrete host in it, stays beside the headline as the technical detail.
//
// The exhaustive `Record<ConnectionFailureCause, …>` is the tier-2 drift guard, as in
// `connectionWarnings.ts`: a backend that adds a cause fails this typecheck until the SPA has copy
// for it, which the typed-key check cannot catch for a runtime-assembled key.

/**
 * Failure class → i18n key, or `null` where there is deliberately no headline to render.
 *
 * `unknown` is that case, and it is the reason the values are nullable: the chain was read and
 * matched nothing, so the only honest statement about it is the backend's verbatim account, which
 * is then rendered as the primary line instead of a headline that would have to invent a class.
 */
export const CONNECTION_FAILURE_CAUSE_KEYS: Record<ConnectionFailureCause, string | null> = {
  refused: 'settings.providerConnection.test.causes.refused',
  dns: 'settings.providerConnection.test.causes.dns',
  timeout: 'settings.providerConnection.test.causes.timeout',
  aborted: 'settings.providerConnection.test.causes.aborted',
  unreachable: 'settings.providerConnection.test.causes.unreachable',
  reset: 'settings.providerConnection.test.causes.reset',
  'tls-untrusted': 'settings.providerConnection.test.causes.tlsUntrusted',
  'tls-expired': 'settings.providerConnection.test.causes.tlsExpired',
  'tls-hostname': 'settings.providerConnection.test.causes.tlsHostname',
  'tls-protocol': 'settings.providerConnection.test.causes.tlsProtocol',
  'invalid-header': 'settings.providerConnection.test.causes.invalidHeader',
  unknown: null,
}
