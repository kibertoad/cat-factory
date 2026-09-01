import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { connectionTestResultSchema } from '../provider-config.js'
import {
  connectServiceCatalogSchema,
  serviceCatalogConnectionSchema,
  serviceCatalogSyncResultSchema,
} from '../service-catalog.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Service-catalog route contracts. See ServiceCatalogController in
// @cat-factory/server. Mounted under `/workspaces/:workspaceId` only, so these literals
// are relative to that prefix and the workspace id is read by the handler.
//
// One connection per workspace, so the resource is a SINGLETON: `PUT` replaces it, `GET`
// reads it, `DELETE` disconnects. There is no id in any path, which is what keeps the
// import's provenance a fact about the workspace rather than a row a caller has to track.
// ---------------------------------------------------------------------------

/**
 * The connection, or null when the workspace has none.
 *
 * Null rather than a 404, because the SPA renders the connect FORM off this read: a 404 there
 * would make "not connected yet" indistinguishable from "wrong workspace id" at exactly the
 * moment the panel has to decide which of the two to show.
 */
export const getServiceCatalogContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/service-catalog',
  responsesByStatusCode: {
    200: v.nullable(serviceCatalogConnectionSchema),
    ...errorResponses,
  },
})

/**
 * Connect or REPLACE the workspace's catalog connection.
 *
 * `PUT` rather than `POST`, because a credential has no meaningful partial edit and a second
 * connection has no meaning: the workspace either points at a portal or it does not. Replacing
 * deliberately does NOT drop what a prior connection imported: the next import reconciles
 * against it, so re-entering a rotated token costs no catalog.
 */
export const connectServiceCatalogContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/service-catalog',
  requestBodySchema: connectServiceCatalogSchema,
  responsesByStatusCode: { 200: serviceCatalogConnectionSchema, ...errorResponses },
})

/**
 * Disconnect: forget the credential AND tombstone every foundational service the connection
 * produced.
 *
 * Tombstoning is the point rather than a side effect. Leaving the imported services behind
 * would keep handing agents an estate nothing refreshes and nothing can explain the provenance
 * of, which is worse than an empty catalog because it still reads as current.
 */
export const disconnectServiceCatalogContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/service-catalog',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Probe the portal with the SUBMITTED credentials, before they are stored.
 *
 * Takes a body rather than reading the stored row, so the operator finds out that a token is
 * wrong while they still have it on screen. It answers a result rather than throwing for the
 * same reason every other connection test does: a refused connection is the answer.
 */
export const probeServiceCatalogContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/service-catalog/probe',
  requestBodySchema: connectServiceCatalogSchema,
  responsesByStatusCode: { 200: connectionTestResultSchema, ...errorResponses },
})

/** Import now, rather than waiting out the autorefresh sweep's staleness window. */
export const syncServiceCatalogContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/service-catalog/sync',
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: serviceCatalogSyncResultSchema, ...errorResponses },
})
