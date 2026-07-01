import { HmacSigner, type MachinePayload, TOKEN_AUDIENCE } from './signing.js'

// The single production mint for a mothership-mode machine token. A mothership mints this
// after a whitelisted login (see the `/auth/machine-token` endpoint) and a local node caches
// it, presenting it on every `/internal/persistence` call. The claim shape it produces is
// EXACTLY the contract `PersistenceController` verifies (`aud: 'machine'` + `scope.accountIds`
// + `exp`), so this helper — not a hand-rolled copy — is the one place that shape is written;
// the mothership specs import it too.

/** Default machine-token lifetime when a facade doesn't configure one (30 days). */
export const DEFAULT_MACHINE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Resolve `AuthConfig.machineTokenTtlMs` from a raw `AUTH_MACHINE_TOKEN_TTL_MS` env value:
 * a positive finite number wins, anything else falls back to {@link DEFAULT_MACHINE_TOKEN_TTL_MS}.
 * Shared by both facade config loaders so the default can't drift between them.
 */
export function resolveMachineTokenTtlMs(raw: string | undefined): number {
  const parsed = raw?.trim() ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MACHINE_TOKEN_TTL_MS
}

/**
 * Mint a `machine`-audience persistence token scoped to `accountIds`, signed with `secret`
 * (the mothership's session secret — the same key `PersistenceController` verifies against).
 * `nodeId` identifies the local node the token is minted for (telemetry / future revocation);
 * `ttlMs` bounds the token's life (default {@link DEFAULT_MACHINE_TOKEN_TTL_MS}).
 */
export function mintMachineToken(
  secret: string,
  opts: { userId: string; accountIds: string[]; nodeId?: string; ttlMs?: number },
): Promise<string> {
  const payload: MachinePayload = {
    aud: TOKEN_AUDIENCE.machine,
    nodeId: opts.nodeId ?? `node_${crypto.randomUUID()}`,
    userId: opts.userId,
    scope: { accountIds: opts.accountIds },
    exp: Date.now() + (opts.ttlMs ?? DEFAULT_MACHINE_TOKEN_TTL_MS),
  }
  return new HmacSigner(secret).sign(payload)
}
