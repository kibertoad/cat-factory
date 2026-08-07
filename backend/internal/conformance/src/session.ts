import { HmacSigner, TOKEN_AUDIENCE, type SessionPayload } from '@cat-factory/server'

// Mint a real signed user session for the auth-ENABLED conformance assertions (workspace
// RBAC). The dev-open harnesses resolve NO access object and allow everything, so an
// RBAC assertion is only meaningful with a genuine per-user session — this signs one with
// the harness's configured `sessionSecret`, sent as `Authorization: Bearer <token>`. Each
// facade harness exposes it as `ConformanceApp.session` bound to its own secret.

export function mintSession(
  secret: string,
  user: { id: string; login?: string; name?: string | null; generation?: number },
): Promise<string> {
  const payload: SessionPayload = {
    id: user.id,
    login: user.login ?? user.id,
    name: user.name ?? null,
    avatarUrl: null,
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 3_600_000,
    // The session generation the bearer is valid under. Defaults to `0`, the value a freshly
    // created `users` row carries, so an assertion that only cares about RBAC needs no setup. A
    // revocation assertion passes the value it expects instead.
    gen: user.generation ?? 0,
  }
  return new HmacSigner(secret).sign(payload)
}
