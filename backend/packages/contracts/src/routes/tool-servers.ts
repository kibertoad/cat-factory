import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  toolServerOAuthStartSchema,
  toolServerProbeResultSchema,
  toolServersViewSchema,
} from '../tool-servers.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace TOOL SERVER (MCP) operability route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
//
// Both routes are `secrets.manage`-gated INCLUDING the read, like the credential checklist beside
// them and for the same reason: the projection names the credential keys the deployment's
// capabilities want. See ToolServerController.
//
// Workspace-scoped even though the DECLARATIONS are deployment-wide, because the credentials are
// not: the per-workspace capability-credential store sits in front of the environment resolver per
// key, so "does this server work" has a different answer per board, and a probe that resolved
// against nothing in particular would report the deployment's own environment as every tenant's
// answer.
// ---------------------------------------------------------------------------

export const listToolServersContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/tool-servers',
  responsesByStatusCode: { 200: toolServersViewSchema, ...errorResponses },
})

// A POST rather than a GET: the probe SPENDS something (an outbound request carrying a resolved
// credential, and a vendor's rate limit), so it must not be safe to retry from a browser's cache or
// a link prefetch. The same shape every neighbouring connection type's `/test` endpoint has.
export const probeToolServerContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: singleStringParam('id'),
  pathResolver: ({ id }) => `/tool-servers/${id}/test`,
  // Nothing to send: WHAT is probed is the path, and everything else the probe needs (the
  // declaration, the workspace's credentials) is resolved server-side from state a caller could not
  // usefully override. A body would be a way to ask the deployment to send a credential of the
  // caller's choosing to an endpoint of the deployment's.
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: toolServerProbeResultSchema, ...errorResponses },
})

// ---- OAuth grants -------------------------------------------------------------------------
//
// The grant itself is per (workspace, server), which is why these sit on the workspace-scoped
// controller beside the probe: the DECLARATION is deployment-wide, and who authorised what against
// it is a board's own business. The callback the vendor redirects to is deliberately NOT here — it
// is a browser navigation from a third party, so it cannot be workspace-scoped, cannot be gated on
// this controller's permission, and is mounted at the app root instead.

// Begin an `authorization_code` grant: returns the vendor's authorization URL to send the operator
// to. A POST because it MINTS state (a sealed, expiring authorization request bound to this
// workspace, server and user), which is not something a link prefetch may do.
export const startToolServerOAuthContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: singleStringParam('id'),
  pathResolver: ({ id }) => `/tool-servers/${id}/oauth/authorize`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: toolServerOAuthStartSchema, ...errorResponses },
})

// Drop this workspace's grant. The next dispatch reports the server to its agent as
// `oauth_not_connected`, which is the same state as never having connected — deliberately, because
// a disconnect that left the server looking wired would be the "stated, never silent" rule broken
// by the one action an operator takes precisely to stop it being used.
export const disconnectToolServerOAuthContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: singleStringParam('id'),
  pathResolver: ({ id }) => `/tool-servers/${id}/oauth`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
