// Shared test fixtures for the mothership-mode specs (the in-process conformance harness in
// `harness.ts` and the real-loopback functional test in `../mothership-integration.spec.ts`).
// Both stand up a stock Node mothership + present a `machine`-audience token on every persistence
// RPC; this module is the single definition of the test secrets and the mothership-side env base.
// The machine-token mint itself is the PRODUCTION `mintMachineToken` (`@cat-factory/server`) —
// the same helper the `/auth/machine-token` endpoint uses — so the specs can't drift from the
// real claim shape `PersistenceController` verifies.
//
// NOTE: only the MOTHERSHIP side is shared here. The two specs' systems-under-test diverge on
// purpose (the functional test wires the real `HttpPersistenceRpcClient` over a loopback HTTP
// server via `LOCAL_MOTHERSHIP_URL`/`_TOKEN`, while the harness forwards in-process over
// `app.fetch`), so their SUT envs + transports are intentionally NOT unified.

export { mintMachineToken } from '@cat-factory/server'

/** The session secret both sides sign/verify the machine token with. */
export const SESSION_SECRET = 'mothership-test-session-secret-0123456789'

/** The shared encryption key (a 32-byte zero key, base64) — local secrets seal under it in tests. */
export const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

/**
 * The mothership-side env base: a stock Node backend with every integration the SUT delegates to
 * it ENABLED (so its repository registry actually wires those repos — a remote call to an unwired
 * repo otherwise comes back `... is not wired`). It is NOT dev-open; it only answers the
 * machine-token RPC, so a login provider (password over the shared secret) satisfies the boot
 * guard. Pass `overrides` for any per-spec extras (e.g. `SLACK_ENABLED`).
 */
export function buildMothershipEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENVIRONMENT: 'test',
    ENCRYPTION_KEY,
    AUTH_SESSION_SECRET: SESSION_SECRET,
    AUTH_PASSWORD_ENABLED: 'true',
    ENVIRONMENTS_ENABLED: 'true',
    PROMPT_LIBRARY_ENABLED: 'true',
    DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
    ...overrides,
  }
}
