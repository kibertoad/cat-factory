import * as v from 'valibot'
import { publicApiScopeSchema } from './public-api-keys.js'

// ---------------------------------------------------------------------------
// The SERVING side of MCP authorization, as the SPA sees it: the two session-gated calls the
// consent screen makes while an MCP host waits on a redirect.
//
// Everything else in that flow speaks OAuth on the wire (RFC 6749/7591/8414/9728 shapes, answered
// by `McpAuthorizationController`) and has no contract here, because those bodies are a third
// party's specification rather than this platform's. What IS ours is the pair below: what a human
// is told about the party asking, and what they decided.
// ---------------------------------------------------------------------------

/** The sealed authorization request the consent page carries, as minted by `GET /oauth/authorize`. */
const sealedRequestSchema = v.pipe(v.string(), v.minLength(1))

export const mcpAuthorizationDescribeSchema = v.object({ request: sealedRequestSchema })
export type McpAuthorizationDescribe = v.InferOutput<typeof mcpAuthorizationDescribeSchema>

/**
 * What the consent screen renders about the host asking.
 *
 * Deliberately three fields and no more. A consent screen that lists everything it knows is one
 * nobody reads, and the only facts a person can actually judge are WHO says they are asking (a name
 * a stranger chose, so it is presented as a claim), WHERE the browser will be sent afterwards (the
 * one value the flow's security rests on and the one an attacker cannot fake, since it was matched
 * against a registration), and what the host ASKED for, which the screen offers as a default rather
 * than as a fact about what will be granted.
 */
export const mcpAuthorizationRequestViewSchema = v.object({
  clientName: v.string(),
  redirectOrigin: v.string(),
  requestedScope: v.optional(publicApiScopeSchema),
})
export type McpAuthorizationRequestView = v.InferOutput<typeof mcpAuthorizationRequestViewSchema>

/**
 * The decision, as a variant rather than a flag with optional siblings: an approval that named no
 * board or no scope is not a decision this surface can act on, and a shape that could express one
 * would push that check into the handler, where a later edit can drop it.
 */
export const mcpAuthorizationDecisionSchema = v.variant('decision', [
  v.object({
    decision: v.literal('approve'),
    request: sealedRequestSchema,
    /** The board the issued key acts on. Every call the host then makes is bound to it. */
    workspaceId: v.pipe(v.string(), v.minLength(1)),
    scope: publicApiScopeSchema,
  }),
  v.object({
    decision: v.literal('deny'),
    request: sealedRequestSchema,
  }),
])
export type McpAuthorizationDecision = v.InferOutput<typeof mcpAuthorizationDecisionSchema>

/**
 * Where the browser goes next: back to the host, carrying either the code or the refusal.
 *
 * Answered as DATA the page navigates to, rather than served as a redirect. The call is an
 * authenticated `fetch` from the SPA, and a 302 on a `fetch` is followed by the browser without the
 * page ever seeing it, which would send the host's callback an XHR instead of a navigation.
 */
export const mcpAuthorizationRedirectSchema = v.object({ redirectTo: v.string() })
export type McpAuthorizationRedirect = v.InferOutput<typeof mcpAuthorizationRedirectSchema>
