import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Directory sync vocabulary: the entities an external system mirrors from an account (who is in
// it, which boards they reach, which repositories each board links). Design and slice plan:
// docs/initiatives/directory-sync.md.
//
// The entity type is persisted on every change-feed row and published on the wire, so this list
// is append-only: retiring a member strands rows that still carry it.
// ---------------------------------------------------------------------------

export const DIRECTORY_ENTITY_TYPES = [
  'workspace',
  'user',
  'account_membership',
  'workspace_membership',
  'repo',
] as const
export const directoryEntityTypeSchema = v.picklist(DIRECTORY_ENTITY_TYPES)
export type DirectoryEntityType = v.InferOutput<typeof directoryEntityTypeSchema>

export function isDirectoryEntityType(value: string): value is DirectoryEntityType {
  return (DIRECTORY_ENTITY_TYPES as readonly string[]).includes(value)
}
