import type { WorkspaceMetadata } from '@cat-factory/contracts'

/**
 * Normalise a submitted custom-metadata bag before it is persisted.
 *
 * The schema already bounds the shape (key form, value length, entry count); this owns the
 * one piece of MEANING the store has about these values: a field is either set to something,
 * or it is not there at all.
 *
 * - Values are trimmed, because they are typed into a text input and a trailing space in an
 *   external tool's URL parameter is a broken link nobody can see in the editor.
 * - A value that is empty after trimming DROPS its key. The editor renders every declared
 *   field, so a cleared input arrives as `''`; storing that would leave readers unable to tell
 *   "unset" from "deliberately blank" — and an external-tool resolver checking
 *   `ctx.metadata.gameId` would happily build a URL with an empty game id instead of reporting
 *   the field as missing.
 *
 * Pure and total: an unknown key (one no field currently declares) is preserved, since a
 * deployment may have retired the field while the value it wrote is still meaningful to
 * whatever reads it.
 */
export function normalizeWorkspaceMetadata(metadata: WorkspaceMetadata): WorkspaceMetadata {
  const out: WorkspaceMetadata = {}
  for (const [key, value] of Object.entries(metadata)) {
    const trimmed = value.trim()
    if (trimmed) out[key] = trimmed
  }
  return out
}
