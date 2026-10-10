import { defineApiContract } from '@toad-contracts/valibot'
import {
  mcpAuthorizationDecisionSchema,
  mcpAuthorizationDescribeSchema,
  mcpAuthorizationRedirectSchema,
  mcpAuthorizationRequestViewSchema,
} from '../mcp-authorization.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// The consent screen's two calls, mounted at the ROOT rather than under `/workspaces/:ws`.
//
// The board is not in the path because the request arrives before anyone has chosen one: an MCP
// host asks this deployment for access, and WHICH board it gets is the answer a human gives on the
// screen these two calls drive. So the workspace rides the approval body and its `secrets.manage`
// check is resolved in the handler through the one shared workspace-access resolution, exactly as
// the consuming side's completion does with the board sealed into its vendor state.
//
// Both are POSTs, including the read. The sealed request is not an identifier to look up but a
// value the caller presents, and putting it in a query string would write it into browser history,
// server logs and any proxy in between, on a surface whose whole subject is an authorization about
// to be granted.
// ---------------------------------------------------------------------------

export const describeMcpAuthorizationContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/mcp/authorization/describe',
  requestBodySchema: mcpAuthorizationDescribeSchema,
  responsesByStatusCode: { 200: mcpAuthorizationRequestViewSchema, ...errorResponses },
})

export const decideMcpAuthorizationContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/mcp/authorization/decision',
  requestBodySchema: mcpAuthorizationDecisionSchema,
  responsesByStatusCode: { 200: mcpAuthorizationRedirectSchema, ...errorResponses },
})
