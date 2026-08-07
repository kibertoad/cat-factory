import type {
  DocumentConnectionRepository,
  DocumentConnectionStore,
  DocumentSourceKind,
  SecretCipher,
  SecretDelegate,
} from '@cat-factory/kernel'
import { createOrgSecretCipher } from '@cat-factory/kernel'
import { createSealedConnectionStore } from '../shared/sealedConnectionStore.js'

export interface DocumentConnectionStoreDependencies {
  documentConnectionRepository: DocumentConnectionRepository
  /** The deployment's `cat-factory:documents` cipher. */
  secretCipher: SecretCipher
  /**
   * Present ONLY on a mothership-mode node, where the row was sealed under the MOTHERSHIP's key
   * and this process holds none. Without it a mothership-mode deployment could store a document
   * connection and never authenticate with it, which is the shape this whole integration was
   * parked on until the row started carrying its envelope.
   */
  secretDelegate?: SecretDelegate
}

/**
 * The one place a document-source credential bag is sealed or opened, over the
 * `document_source_connection` entry of the mothership's org-secret table.
 */
export function createDocumentConnectionStore(
  deps: DocumentConnectionStoreDependencies,
): DocumentConnectionStore {
  return createSealedConnectionStore<DocumentSourceKind>({
    repository: deps.documentConnectionRepository,
    orgSecrets: createOrgSecretCipher({
      cipher: deps.secretCipher,
      ...(deps.secretDelegate ? { delegate: deps.secretDelegate } : {}),
    }),
    secretSource: 'document_source_connection',
  })
}
