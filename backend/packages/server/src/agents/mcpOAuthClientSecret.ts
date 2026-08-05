import type { Logger, McpOAuthConfig, ToolSecretResolver } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import { isReservedPlatformEnvKey, reservedEnvKeyMessage } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Resolving a tool server's OAuth CLIENT SECRET, shared by the two places that need one: the
// dispatch-time token source and the interactive callback that completes a grant.
//
// One module rather than a lookup at each site, because the two would then have to agree about
// the reserved-key floor, and a floor enforced in one of two places is not a floor. It is the same
// floor `resolveToolServers` and the probe apply to `secretKeys`, for the identical reason: a
// declaration names both the key it wants and the token endpoint that key is posted to, so
// `clientSecretKey: 'ENCRYPTION_KEY'` would otherwise boot clean and hand a third party the
// deployment's master sealing key.
// ---------------------------------------------------------------------------

/** Either the secret (absent when the declaration named no key), or why it cannot be supplied. */
export type OAuthClientSecretResolution =
  | { ok: true; value?: string }
  | { ok: false; error: string }

export interface ResolveOAuthClientSecretInput {
  workspaceId: string
  serverId: string
  oauth: Pick<McpOAuthConfig, 'clientSecretKey'>
  /** The composed capability-credential chain. Absent ⇒ a declared key resolves to nothing. */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

/**
 * The OAuth client secret, when the declaration named a key for one.
 *
 * A declared-but-unresolved secret is a REFUSAL rather than a silent public-client request: the
 * deployment SAID this client authenticates with a secret, so sending the request without one asks
 * the authorization server a question the platform already knows the answer to, and its 401 would
 * name the client rather than the missing value.
 */
export async function resolveOAuthClientSecret(
  input: ResolveOAuthClientSecretInput,
): Promise<OAuthClientSecretResolution> {
  const logger = input.logger ?? noopLogger
  const key = input.oauth.clientSecretKey
  if (!key) return { ok: true }
  if (isReservedPlatformEnvKey(key)) {
    logger.warn('tool server oauth declares a reserved client-secret key; refusing to resolve it', {
      toolServerId: input.serverId,
      credentialKey: key,
      detail: reservedEnvKeyMessage(key),
    })
    return {
      ok: false,
      error:
        `The OAuth client secret is looked up by ${key}, which names a variable the platform's ` +
        `own configuration owns. Change the declaration; setting the variable must not help.`,
    }
  }
  const resolver = input.resolveToolSecrets
  const resolved = resolver
    ? ((await runBestEffort(
        logger,
        'resolve tool-server oauth client secret',
        () =>
          resolver.resolve({
            workspaceId: input.workspaceId,
            subject: { kind: 'tool-server', id: input.serverId },
            keys: [{ key }],
          }),
        { toolServerId: input.serverId },
      )) ?? {})
    : {}
  const value = resolved[key]
  if (!value) {
    return {
      ok: false,
      error:
        `The OAuth client secret ${key} is not configured for this workspace, and the ` +
        `declaration says this client authenticates with one.`,
    }
  }
  return { ok: true, value }
}
