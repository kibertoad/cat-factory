import {
  decideMcpAuthorizationContract,
  describeMcpAuthorizationContract,
  type McpAuthorizationDecision,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The consent screen an MCP host's authorization request lands on.
 *
 * The mirror image of the tool-server OAuth calls beside it: those connect THIS deployment to
 * someone else's MCP server, these let someone else's host connect to this one. Neither is
 * workspace-prefixed, and for opposite reasons: there the board is sealed into the vendor's state,
 * here it is what the person on the screen is choosing.
 *
 * Both are POSTs, the read included. The sealed request is a value the page carries rather than an
 * id it looks up, and a query string would write it into browser history and every log in between.
 */
export function mcpAuthorizationApi({ send }: ApiContext) {
  return {
    describeMcpAuthorization: (request: string) =>
      send(describeMcpAuthorizationContract, { body: { request } }),

    // Answers with WHERE to send the browser, rather than redirecting: a 302 on a `fetch` is
    // followed by the browser without this page seeing it, which would deliver the host's callback
    // an XHR instead of the navigation it is waiting for.
    decideMcpAuthorization: (body: McpAuthorizationDecision) =>
      send(decideMcpAuthorizationContract, { body }),
  }
}
