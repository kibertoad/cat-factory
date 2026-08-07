import type {
  SecretCipher,
  SecretDelegate,
  TaskConnectionRepository,
  TaskConnectionStore,
  TaskSourceKind,
} from '@cat-factory/kernel'
import { createOrgSecretCipher } from '@cat-factory/kernel'
import { createSealedConnectionStore } from '../shared/sealedConnectionStore.js'

export interface TaskConnectionStoreDependencies {
  taskConnectionRepository: TaskConnectionRepository
  /** The deployment's `cat-factory:tasks` cipher. */
  secretCipher: SecretCipher
  /**
   * Present ONLY on a mothership-mode node, where the row was sealed under the MOTHERSHIP's key
   * and this process holds none. The tracker step files a ticket on the RUN path, so without it a
   * mothership-mode run reaches that step and fails there.
   */
  secretDelegate?: SecretDelegate
}

/**
 * The one place a tracker credential bag is sealed or opened, over the `task_source_connection`
 * entry of the mothership's org-secret table.
 */
export function createTaskConnectionStore(
  deps: TaskConnectionStoreDependencies,
): TaskConnectionStore {
  return createSealedConnectionStore<TaskSourceKind>({
    repository: deps.taskConnectionRepository,
    orgSecrets: createOrgSecretCipher({
      cipher: deps.secretCipher,
      ...(deps.secretDelegate ? { delegate: deps.secretDelegate } : {}),
    }),
    secretSource: 'task_source_connection',
  })
}
