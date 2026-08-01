import type { WorkspaceMetadata } from '~/types/domain'

/**
 * CUSTOM WORKSPACE METADATA FIELDS — the deployment declares the fields in code, an operator
 * fills in the VALUES per workspace in the settings panel, and anything that needs
 * workspace-specific context reads them back (today: an {@link ExternalToolUrlResolver}, which
 * is what makes "open the map editor already switched to this board's game" a registration
 * rather than a fork).
 *
 * Definitions are code-shipped rather than stored, for the same reason result views and task
 * types are: they carry behaviour (which tool reads them, what a value means) that only the
 * deployment knows, and a deployment must be able to add, rename and retire a field without a
 * migration. The BACKEND therefore validates only the shape of the bag, never the field list
 * (see `workspaceMetadataSchema` in `@cat-factory/contracts`).
 *
 * Pure — no Vue, no stores — so the editor's merge rules are unit-testable.
 */

/** How a field's value is edited. Stored as a string either way (the bag is a string map). */
export type WorkspaceMetadataFieldType = 'text' | 'number' | 'select'

/** One declared field. */
export interface WorkspaceMetadataFieldDefinition {
  /**
   * The key the value is stored under and a resolver reads off `ctx.metadata`. Must be
   * identifier-shaped (see {@link isValidMetadataKey}) — the backend refuses anything else, so
   * a malformed key is dropped at boot rather than 422-ing the operator's save.
   */
  key: string
  /** Field label. Literal copy, like an external tool's title: deployment data, not a key. */
  label: string
  /** Optional help text under the input. */
  description?: string
  /** Placeholder for the empty input. */
  placeholder?: string
  /** Input flavour; defaults to `text`. */
  type?: WorkspaceMetadataFieldType
  /** The choices for a `select` field. Ignored for the other types. */
  options?: readonly { value: string; label: string }[]
  /** Ordering within the metadata editor. Defaults to 0. */
  order?: number
}

/**
 * The key shape the backend accepts (mirrors `workspaceMetadataKeySchema`). Mirrored rather
 * than imported as a value because the contract expresses it as a valibot schema; the pattern
 * is pinned equal by `workspace-metadata.spec.ts`.
 */
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

/** Whether a declared key is one the store will accept. */
export function isValidMetadataKey(key: string): boolean {
  return METADATA_KEY_PATTERN.test(key)
}

/**
 * Read one value out of a stored bag, as an OWN property.
 *
 * A plain `bag[key]` is not that. {@link METADATA_KEY_PATTERN} requires a leading letter, which
 * keeps `__proto__` out, but `constructor`, `toString` and `valueOf` are all legal field keys —
 * and on a plain object (which is what `JSON.parse` hands back) each of those reads as an
 * INHERITED function rather than `undefined` when nobody has filled the field in. That is not a
 * cosmetic difference: a truthy read makes `resolveExternalToolUrl`'s required-metadata check
 * conclude the field IS set, and a function reaching the editor's draft is a `TypeError` on the
 * next save. Both failures would name a field the operator never mistyped.
 */
export function metadataValue(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(bag, key)) return undefined
  const value = bag[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * A stored bag re-hung on a NULL PROTOTYPE, so `bag.anything` is either a stored string or
 * `undefined` for every reader.
 *
 * {@link metadataValue} is the disciplined way to read one key, but the bag's whole purpose is
 * to be handed to a DEPLOYMENT'S OWN resolver, which writes `ctx.metadata.gameId` and cannot be
 * made to call our helper. Sanitising the object once at that boundary is what makes the plain
 * property access those resolvers will write correct by construction.
 */
export function toMetadataBag(stored: WorkspaceMetadata): Readonly<Record<string, string>> {
  const bag: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'string') bag[key] = value
  }
  return bag
}

/**
 * The fields to render: valid keys only, first declaration wins on a duplicate, ordered.
 *
 * A code-shipped definition is trusted the way a code-shipped task type is — no boot-time
 * registry validation — so a malformed key is dropped HERE, with the rejects returned rather
 * than swallowed, and the caller warns. Rendering it instead would produce an editor whose
 * every save 422s with a message about a key the operator never typed.
 */
export function resolveMetadataFields(definitions: readonly WorkspaceMetadataFieldDefinition[]): {
  fields: WorkspaceMetadataFieldDefinition[]
  rejected: WorkspaceMetadataFieldDefinition[]
} {
  const fields: WorkspaceMetadataFieldDefinition[] = []
  const rejected: WorkspaceMetadataFieldDefinition[] = []
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (!isValidMetadataKey(definition.key) || seen.has(definition.key)) {
      rejected.push(definition)
      continue
    }
    seen.add(definition.key)
    fields.push(definition)
  }
  return {
    fields: fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    rejected,
  }
}

/** The editor's starting draft: every declared field, empty when the workspace has no value. */
export function metadataDraftFrom(
  fields: readonly WorkspaceMetadataFieldDefinition[],
  stored: WorkspaceMetadata,
): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const field of fields) draft[field.key] = metadataValue(stored, field.key) ?? ''
  return draft
}

/**
 * The bag to submit: the draft's non-empty values, PLUS every stored key the editor did not
 * render.
 *
 * That second half is the whole rule. The update contract replaces the bag wholesale (so a
 * cleared field can actually disappear), which means a save from an editor showing five fields
 * would otherwise DELETE a value written under a field this build no longer declares — a
 * deployment mid-rollout, a retired-but-still-read field, a value another version wrote. A
 * REPLACE-style write must never silently drop state it doesn't render.
 *
 * Trimming and empty-dropping mirror the backend's normalisation, so the editor shows the same
 * bag the server will store rather than one that changes shape on the round trip.
 *
 * The carried-over keys count against the contract's per-workspace entry cap like any other, so
 * a bag already near it can refuse a save over fields the editor doesn't show. That is the right
 * end of the trade: dropping what we don't render to stay under the cap would be exactly the
 * silent deletion this function exists to prevent, and the cap is generous next to the number of
 * fields a deployment declares.
 *
 * `draft` is typed `unknown`-valued and coerced rather than trusted as a string map: it is bound
 * straight to the editor's inputs, and a `number` field's `v-model` hands back a NUMBER, on which
 * `.trim()` throws. `BudgetSettings.vue` wraps the same control's value in `String(...)` for the
 * same reason. The declared type would say otherwise, which is precisely why it must not.
 */
export function metadataPatchFrom(
  fields: readonly WorkspaceMetadataFieldDefinition[],
  draft: Readonly<Record<string, unknown>>,
  stored: WorkspaceMetadata,
): WorkspaceMetadata {
  const rendered = new Set(fields.map((f) => f.key))
  // Null-prototype for the same reason as `toMetadataBag`: this is a data bag being assembled
  // from stored keys, and an assignment to an inherited slot is never what was meant.
  const patch: WorkspaceMetadata = Object.create(null)
  for (const [key, value] of Object.entries(stored)) {
    if (!rendered.has(key)) patch[key] = value
  }
  for (const field of fields) {
    const value = String(draft[field.key] ?? '').trim()
    if (value) patch[field.key] = value
  }
  return patch
}
