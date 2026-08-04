import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { toolServerProbeResultSchema, toolServersViewSchema } from '../tool-servers.js'
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
