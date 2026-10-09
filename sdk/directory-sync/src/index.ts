// `@cat-factory/directory-sync`: keep a copy of a cat-factory account's directory (workspaces,
// users, account and workspace memberships, linked repositories) in sync over your own storage.
// Design: docs/initiatives/directory-sync.md in the cat-factory repository.

export {
  type DeliveryResult,
  type DirectoryClient,
  DirectorySyncer,
  type DirectorySyncerOptions,
  type SyncResult,
} from './syncer.ts'
export {
  type DirectoryEntities,
  type DirectoryEntityType,
  type DirectoryRecord,
  type DirectoryStore,
  entityKey,
  MemoryDirectoryStore,
  recordOf,
} from './store.ts'
