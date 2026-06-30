import {
  listEnvironmentHandlersContract,
  listEnvironmentUserHandlersContract,
  registerEnvironmentHandlerContract,
  removeCustomManifestTypeContract,
  removeEnvironmentUserHandlerContract,
  unregisterEnvironmentHandlerContract,
  upsertCustomManifestTypeContract,
  upsertEnvironmentUserHandlerContract,
} from '@cat-factory/contracts'
import type {
  ProvisionType,
  RegisterEnvironmentHandlerInput,
  UpsertCustomManifestTypeInput,
  UpsertEnvironmentUserHandlerBody,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Per-provision-type infra HANDLER config (the workspace + per-user "how"): the batched
 * handler bundle (every workspace handler + the custom-manifest-type catalog),
 * register/remove for a workspace handler, custom-type CRUD, and — local mode only —
 * the per-user override handlers (mounted at `/me/...`, so user-scoped, no `/workspaces`
 * prefix; these 503 off the local facade). See EnvironmentController +
 * EnvironmentUserHandlerController in @cat-factory/server.
 */
export function infraHandlersApi({ send, ws }: ApiContext) {
  return {
    // ---- Workspace per-type handlers + custom-type catalog ------------------
    listEnvironmentHandlers: (workspaceId: string) =>
      send(listEnvironmentHandlersContract, { pathPrefix: ws(workspaceId) }),

    registerEnvironmentHandler: (workspaceId: string, body: RegisterEnvironmentHandlerInput) =>
      send(registerEnvironmentHandlerContract, { pathPrefix: ws(workspaceId), body }),

    // `manifestId` (for a `custom` handler) rides as a query param; absent ⇒ the bare handler.
    unregisterEnvironmentHandler: (
      workspaceId: string,
      provisionType: ProvisionType,
      manifestId?: string,
    ) =>
      send(unregisterEnvironmentHandlerContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { provisionType },
        queryParams: { manifestId },
      }),

    upsertCustomManifestType: (
      workspaceId: string,
      manifestId: string,
      body: UpsertCustomManifestTypeInput,
    ) =>
      send(upsertCustomManifestTypeContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { manifestId },
        body,
      }),

    removeCustomManifestType: (workspaceId: string, manifestId: string) =>
      send(removeCustomManifestTypeContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { manifestId },
      }),

    // ---- Per-USER override handlers (local mode; `/me/...`, no ws prefix) ----
    listEnvironmentUserHandlers: (workspaceId: string) =>
      send(listEnvironmentUserHandlersContract, { pathParams: { workspaceId } }),

    upsertEnvironmentUserHandler: (
      workspaceId: string,
      provisionType: ProvisionType,
      body: UpsertEnvironmentUserHandlerBody,
    ) =>
      send(upsertEnvironmentUserHandlerContract, {
        pathParams: { workspaceId, provisionType },
        body,
      }),

    removeEnvironmentUserHandler: (
      workspaceId: string,
      provisionType: ProvisionType,
      manifestId?: string,
    ) =>
      send(removeEnvironmentUserHandlerContract, {
        pathParams: { workspaceId, provisionType },
        queryParams: { manifestId },
      }),
  }
}
