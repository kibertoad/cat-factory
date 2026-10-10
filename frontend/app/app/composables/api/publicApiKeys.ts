import {
  createPublicApiKeyContract,
  listPublicApiKeysContract,
  revokePublicApiKeyContract,
} from '@cat-factory/contracts'
import type { CreatePublicApiKeyInput } from '~/types/publicApiKeys'
import type { ApiContext } from './context'

/**
 * Inbound public-API keys ("API access tokens") a workspace mints for external systems to
 * call the `/api/v1` surface. Management routes are session-authed under
 * `/workspaces/:workspaceId`; the raw secret comes back only on create. See
 * PublicApiKeyController.
 */
export function publicApiKeysApi({ send, ws }: ApiContext) {
  return {
    listPublicApiKeys: (workspaceId: string) =>
      send(listPublicApiKeysContract, { pathPrefix: ws(workspaceId) }),

    createPublicApiKey: (workspaceId: string, body: CreatePublicApiKeyInput) =>
      send(createPublicApiKeyContract, { pathPrefix: ws(workspaceId), body }),

    revokePublicApiKey: (workspaceId: string, id: string) =>
      send(revokePublicApiKeyContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),
  }
}
