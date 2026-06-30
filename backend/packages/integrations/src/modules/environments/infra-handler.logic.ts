import type { InfraEngine, ProvisionType, ServiceProvisioning } from '@cat-factory/kernel'

// Pure resolution of a service's provision type → the workspace/user handler that serves
// it (the "how"). No IO: both the start-time tester gate and the deployer/provisioning path
// feed it already-batched handler lists (one `listByWorkspace` + one `listByUserWorkspace`,
// per "No N+1"). A per-user override (local mode) wins over the workspace handler. See
// docs/initiatives/per-service-provision-types.md.

/** The minimal shape resolution needs — satisfied by both the workspace handler row and the per-user override row. */
export interface InfraHandlerLike {
  provisionType: string
  /** For `custom`: which manifest id this handler is for; `null` otherwise. */
  manifestId: string | null
  engine: string
  /** For `remote-custom`: the manifest id this provider accepts; `null` otherwise. */
  acceptsManifestId: string | null
}

export type InfraHandlerResolution<T extends InfraHandlerLike> =
  | {
      ok: true
      /** The resolved engine (`none` for infraless — `handler` is then null). */
      engine: InfraEngine
      handler: T | null
      /** True when a per-user override (local mode) supplied the handler. */
      fromUserOverride: boolean
    }
  | { ok: false; reason: 'no-handler' | 'type-mismatch' }

/** Does a handler serve a `custom` service pinning `manifestId` (or bare `custom`)? */
function matchesCustom(handler: InfraHandlerLike, manifestId: string | null | undefined): boolean {
  if (handler.provisionType !== 'custom') return false
  if (manifestId == null) return true // bare `custom` — any custom handler is a candidate
  // A handler matches a pinned id either by being keyed to it, or by declaring it acceptable.
  return handler.manifestId === manifestId || handler.acceptsManifestId === manifestId
}

/** Candidates from one list (already user-override-or-workspace) for the service's type. */
function candidatesFor<T extends InfraHandlerLike>(
  handlers: T[],
  type: ProvisionType,
  manifestId: string | null | undefined,
): T[] {
  if (type === 'custom') return handlers.filter((h) => matchesCustom(h, manifestId))
  return handlers.filter((h) => h.provisionType === type)
}

/**
 * Resolve the handler for a service's declared provisioning. Precedence: a per-user override
 * (local mode) wins over the workspace handler. `infraless` short-circuits to the synthetic
 * `none` engine. A bare `custom` declaration (no `manifestId`) resolves only when exactly one
 * candidate matches — ambiguity is rejected rather than silently picked.
 */
export function resolveInfraHandler<T extends InfraHandlerLike>(
  service: Pick<ServiceProvisioning, 'type' | 'manifestId'>,
  workspaceHandlers: T[],
  userOverrides: T[] = [],
): InfraHandlerResolution<T> {
  if (service.type === 'infraless') {
    return { ok: true, engine: 'none', handler: null, fromUserOverride: false }
  }

  for (const [handlers, fromUserOverride] of [
    [userOverrides, true],
    [workspaceHandlers, false],
  ] as const) {
    const candidates = candidatesFor(handlers, service.type, service.manifestId)
    if (candidates.length === 0) continue
    if (candidates.length > 1) {
      // Only a bare `custom` declaration can be ambiguous (multiple custom handlers); a
      // keyed type yields at most one row per the composite primary key.
      return { ok: false, reason: 'type-mismatch' }
    }
    const handler = candidates[0]!
    return { ok: true, engine: handler.engine as InfraEngine, handler, fromUserOverride }
  }

  return { ok: false, reason: 'no-handler' }
}
