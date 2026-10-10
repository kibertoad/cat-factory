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

/**
 * The `details.reason` both calls answer when the sealed request itself is absent, forged or
 * expired: the ONE refusal in this flow that is TERMINAL.
 *
 * Stated here because both sides have to agree about it and they agree about nothing else in a
 * refusal: the backend does not localize prose, and the screen has to choose between two completely
 * different reactions. This reason means the value the page holds is gone, so nothing it can do
 * will bring it back and the only honest instruction is "start again from your host". Every OTHER
 * refusal (a board this person may not mint a key on, a board that vanished, an outage) leaves the
 * request valid and the person able to answer differently, so the screen must keep the choices in
 * front of them. Distinguished by the code rather than by the status, because a 401 the session
 * gate raised and a 401 raised here would otherwise read the same.
 */
export const MCP_AUTHORIZATION_REQUEST_INVALID = 'mcp_authorization_request_invalid'

/** The sealed authorization request the consent page carries, as minted by `GET /oauth/authorize`. */
const sealedRequestSchema = v.pipe(v.string(), v.minLength(1))

export const mcpAuthorizationDescribeSchema = v.object({ request: sealedRequestSchema })
export type McpAuthorizationDescribe = v.InferOutput<typeof mcpAuthorizationDescribeSchema>

/**
 * What the consent screen renders about the host asking.
 *
 * Deliberately few fields. A consent screen that lists everything it knows is one nobody reads, and
 * the only facts a person can actually judge are WHO says they are asking (a name a stranger chose,
 * so it is presented as a claim), WHERE the browser will be sent afterwards (the one value the
 * flow's security rests on and the one an attacker cannot fake, since it was matched against a
 * registration), and what the grant would be.
 *
 * That last one is TWO fields on purpose, and the split is the point. `defaultScope` is what the
 * screen preselects and the server decides; `requestedScope` is what the host asked for, which an
 * unauthenticated registration can set to anything. Collapsed into one, a stranger's ask IS the
 * preselection, and the top of the ladder becomes the default on a screen whose subject is a grant.
 */
export const mcpAuthorizationRequestViewSchema = v.object({
  clientName: v.string(),
  redirectOrigin: v.string(),
  /** What the screen preselects. Never a scope the host asked for above the platform's default. */
  defaultScope: publicApiScopeSchema,
  /** What the host asked for, for the screen to SAY when it differs from what is preselected. */
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
