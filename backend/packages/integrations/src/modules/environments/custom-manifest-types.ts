import type { CustomManifestType, CustomManifestTypeRecord } from '@cat-factory/kernel'

// The custom-manifest-type catalog seam. The full set of `custom` provision types a service
// can declare is the union of:
//  - programmatically-REGISTERED types (a deployment/provider package registers them by
//    reference into this app-owned registry), and
//  - WORKSPACE-defined types (UI-editable rows, persisted in `custom_manifest_types`).
// The registry is an INSTANCE owned by the composition root (mirroring
// EnvironmentBackendRegistry), not a module-global Map — a deployment teaches the platform a
// custom type by holding the same instance and calling `register`. See
// docs/initiatives/per-service-provision-types.md.

/** A programmatically-registered custom manifest type definition. */
export interface RegisteredCustomManifestType {
  manifestId: string
  label: string
  /** Optional hint describing the input shape the provider expects. */
  acceptsInputHint?: string
  description?: string
}

export class CustomManifestTypeRegistry {
  private readonly map = new Map<string, RegisteredCustomManifestType>()

  /** Register (or replace by `manifestId`) a code-defined custom manifest type. */
  register(def: RegisteredCustomManifestType): this {
    this.map.set(def.manifestId, def)
    return this
  }

  /** All registered (code-defined) types. */
  list(): RegisteredCustomManifestType[] {
    return [...this.map.values()]
  }
}

/**
 * Merge the registered (code) types with a workspace's persisted rows into the wire catalog.
 * Deduped by `manifestId`; a workspace row overrides a registered one of the same id (the
 * operator's edit wins), and the merged entry keeps `source: 'workspace'` so the UI knows it
 * is editable.
 */
export function aggregateCustomManifestTypes(
  registered: RegisteredCustomManifestType[],
  workspaceRows: CustomManifestTypeRecord[],
): CustomManifestType[] {
  const byId = new Map<string, CustomManifestType>()
  for (const def of registered) {
    byId.set(def.manifestId, {
      manifestId: def.manifestId,
      label: def.label,
      source: 'registered',
      ...(def.acceptsInputHint ? { acceptsInputHint: def.acceptsInputHint } : {}),
      ...(def.description ? { description: def.description } : {}),
    })
  }
  for (const row of workspaceRows) {
    byId.set(row.manifestId, {
      manifestId: row.manifestId,
      label: row.label,
      source: 'workspace',
      ...(row.acceptsInputHint ? { acceptsInputHint: row.acceptsInputHint } : {}),
      ...(row.description ? { description: row.description } : {}),
    })
  }
  return [...byId.values()].sort((a, b) => a.manifestId.localeCompare(b.manifestId))
}
