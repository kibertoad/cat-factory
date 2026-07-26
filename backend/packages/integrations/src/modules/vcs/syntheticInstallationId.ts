// A stable, positive, 48-bit installation id derived from a workspace id, computed with
// WebCrypto so it runs unchanged on every facade (workerd + Node). It mirrors local mode's
// `syntheticInstallationId` (`runtimes/local/src/installations.ts`) byte-for-byte — both take
// the first 6 bytes of `SHA-1(workspaceId)` — so a workspace resolves to the SAME id whether
// its connection was auto-provisioned in local mode or written by the hosted PAT connect flow.
//
// A PAT connection has no provider-issued installation id (unlike a GitHub App), so we synthesise
// one that is deterministic per workspace: the table's `workspace_id` is unique, so two
// workspaces never collide, and re-connecting the same workspace reuses the id (upsert, not a
// new row). It round-trips through `VcsConnectionRef.connectionId = String(installationId)` and
// back via `Number(connectionId)`, so the token source resolves the row by the same id.
export async function syntheticInstallationId(workspaceId: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(workspaceId))
  // 6 bytes = 48 bits: well inside Number.MAX_SAFE_INTEGER and the bigint id column.
  const bytes = new Uint8Array(digest)
  let value = 0
  for (const byte of bytes.slice(0, 6)) value = value * 256 + byte
  return value
}
