import {
  deleteCapabilityCredentialContract,
  getCapabilityCredentialsContract,
  setCapabilityCredentialContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Per-workspace capability credentials (SEALED, write-only). The GET view returns what this
 * deployment's registered capabilities DECLARE joined to what this workspace has stored, never a
 * value. Writes are PER KEY: the whole-set PUT exists for an API caller declaring a whole set at
 * once, and this client could not use it — it never received the other values, so a set-replacing
 * write here would delete every credential the operator did not retype.
 *
 * `secrets.manage`-gated end to end, the READ included: the view carries the credential key names
 * the deployment's capabilities want, which the workspace snapshot deliberately omits.
 * See CapabilityCredentialsController.
 */
export function capabilityCredentialsApi({ send, ws }: ApiContext) {
  return {
    getCapabilityCredentials: (workspaceId: string) =>
      send(getCapabilityCredentialsContract, { pathPrefix: ws(workspaceId) }),

    setCapabilityCredential: (workspaceId: string, key: string, value: string) =>
      send(setCapabilityCredentialContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { key },
        body: { value },
      }),

    deleteCapabilityCredential: (workspaceId: string, key: string) =>
      send(deleteCapabilityCredentialContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { key },
      }),
  }
}
