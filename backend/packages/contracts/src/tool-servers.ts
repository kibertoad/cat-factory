import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The OPERATOR-facing projection of the tool servers (MCP) a deployment registered, plus the
// result of PROBING one.
//
// The registry itself is deployment CODE — a `McpServerDefinition` on the `AgentKindRegistry`, with
// its credentials resolved per dispatch through the kernel `ToolSecretResolver`. Everything an
// operator could previously learn about it, they learned by reading that code or by starting a run
// and reading the agent's own prompt: boot validation names a broken DECLARATION, and a dispatch
// names a server it DROPPED, but nothing said whether a server that survives both actually answers.
//
// So this module is two vocabularies:
//
//   - {@link toolServerViewSchema}, the non-secret projection of one declaration (what it is, which
//     kinds get it, which harnesses can serve it, which credentials it asks for BY NAME, and
//     whether the deployment can probe it at all);
//   - {@link toolServerProbeResultSchema}, the verdict of speaking `initialize` + `tools/list` to it
//     for real.
//
// Both live here rather than in kernel because the SPA has to state the same judgements to a human,
// and the SPA cannot see kernel. The probe STATUS in particular is a rule both sides agree about:
// the backend decides it, the SPA maps each member to translated copy and a remedy, and a member
// added on one side only would render as a blank chip.
//
// Nothing here carries a credential VALUE. A key NAME is as far as it goes, which is why the whole
// surface is `secrets.manage`-gated (the same judgement the credential checklist makes: what
// variables a deployment's capabilities want is not viewer-tier information).
// ---------------------------------------------------------------------------

/** Which transport a declaration uses, mirroring kernel's `McpTransport['kind']`. */
export const toolServerTransportSchema = v.picklist(['stdio', 'http'])
export type ToolServerTransport = v.InferOutput<typeof toolServerTransportSchema>

/**
 * Why a declared server cannot be probed from the deployment, when it cannot.
 *
 * This is NOT a fault vocabulary: every member describes a server that may be working perfectly on
 * a run. What is missing is a vantage point — the backend is not the run container, and the probe
 * refuses rather than reaching for the nearest thing it CAN talk to. Each member needs a different
 * response from the operator, which is why they are separate:
 *
 * - `stdio_transport` — the server is a child process the harness spawns inside the run container.
 *   The backend has no container to spawn it in, and on the Worker no process model at all. There
 *   is nothing to fix: verify it from a run.
 * - `container_local_url` — an `http` server on loopback means "beside the agent, in its own
 *   container". Probing that address from the backend would reach the BACKEND's own loopback, which
 *   is a different machine and quite possibly a real service, so the answer would be about the
 *   wrong process whether it succeeded or failed. Refused rather than attempted.
 * - `url_not_allowed` — the url fails the transport rule (`isAllowedMcpHttpUrl`: https, or plain
 *   http on loopback). Boot validation already refuses such a declaration, so reaching this means
 *   the definition arrived from somewhere this process never boot-validated (a mothership-mode
 *   node), and the probe holds the same floor the dispatch does.
 */
export const toolServerNotProbeableReasonSchema = v.picklist([
  'stdio_transport',
  'container_local_url',
  'url_not_allowed',
])
export type ToolServerNotProbeableReason = v.InferOutput<typeof toolServerNotProbeableReasonSchema>

/**
 * One credential a declaration asks for, by NAME.
 *
 * `usage` is the declaration's own note on what value belongs here. It is the same field the
 * credential checklist renders, and a tool server's half of it exists because the checklist can only
 * say what the declaration says: a bare `SLACK_MCP_TOKEN` names neither the token TYPE nor its
 * scopes, so without it the operator goes back to the deployment's source.
 */
export const toolServerCredentialSchema = v.object({
  key: v.string(),
  required: v.boolean(),
  usage: v.optional(v.string()),
})
export type ToolServerCredential = v.InferOutput<typeof toolServerCredentialSchema>

/** Which OAuth grant a declaration uses, mirroring kernel's `McpOAuthConfig['grant']`. */
export const toolServerOAuthGrantSchema = v.picklist(['authorization_code', 'client_credentials'])
export type ToolServerOAuthGrant = v.InferOutput<typeof toolServerOAuthGrantSchema>

/**
 * The non-secret state of a workspace's OAuth grant for one tool server: what is persisted beside
 * the sealed tokens, and what the operator surface renders.
 *
 * Never a token, and never a refresh token's presence dressed up as one. The only reason this is a
 * record rather than a boolean is that "connected" is four separate questions an operator asks in
 * sequence — is there a grant, whose account is it, will it keep working, and did the last renewal
 * fail — and a single flag answers the first while silently implying the other three.
 */
export const toolServerOAuthStatusSchema = v.object({
  grant: toolServerOAuthGrantSchema,
  /**
   * Whether this workspace holds a grant for the server.
   *
   * For `client_credentials` this is a fact about a CACHED token rather than about a human
   * decision: nothing needs granting, so a false here means only that no token has been minted
   * yet, and a dispatch mints one. The surface therefore renders the two grants differently and
   * this field is deliberately not overloaded to say so.
   */
  connected: v.boolean(),
  /** Scopes the authorization server actually granted, when it named them. */
  scopes: v.optional(v.array(v.string())),
  /** When the grant was established (epoch ms). */
  connectedAt: v.optional(v.number()),
  /** The user who granted it, so a board can tell whose vendor account its runs authenticate as. */
  connectedBy: v.optional(v.string()),
  /** When the current access token expires (epoch ms), when the server stated an expiry. */
  expiresAt: v.optional(v.number()),
  /**
   * Whether a refresh token was issued.
   *
   * `false` on an `authorization_code` grant is a real and reportable state, not a detail: the
   * connection works until the access token expires and then needs granting again by hand, which
   * an operator can only plan around if the surface says so before it happens.
   */
  refreshable: v.optional(v.boolean()),
  /**
   * Why the last token exchange failed, when one did. Present ALONGSIDE `connected: true`, which
   * is the point: the grant is still on file and is no longer producing tokens, and reporting that
   * as a clean connection is how an operator ends up debugging the agent instead of the vendor.
   * Scrubbed at the emit site.
   */
  lastError: v.optional(v.string()),
})
export type ToolServerOAuthStatus = v.InferOutput<typeof toolServerOAuthStatusSchema>

/**
 * One declared tool server, as an operator sees it.
 *
 * The point of the whole record is that a declaration has FOUR independent ways of not reaching a
 * run, and until this surface existed they were visible in four different places (the deployment's
 * source, a boot log, a run's prompt, and nowhere): which kinds declare it, which harnesses can
 * serve it, whether its credentials resolve, and whether the endpoint answers. The first two are
 * static facts stated here; the last two are what {@link toolServerProbeResultSchema} settles.
 */
export const toolServerViewSchema = v.object({
  id: v.string(),
  label: v.string(),
  transport: toolServerTransportSchema,
  /**
   * What the declaration points at: the url for an `http` server, the command for a `stdio` one.
   * Rendered so the operator can recognise WHICH server a row is, and stripped of any userinfo
   * credential a url carried, because this reaches a browser.
   */
  target: v.string(),
  /** The definition's `guidance` — what the AGENT is told the server is for. */
  guidance: v.optional(v.string()),
  /**
   * The agent kinds this server is declared for, own declarations and `assignToolServers` alike.
   *
   * EMPTY is a real and reportable state: a server registered by id and attached to no kind never
   * reaches a dispatch, so its credentials are keys an operator would fill in for no run. Nothing
   * else says so — boot validation checks declarations reachable FROM a kind, so an orphan registry
   * entry passes every check silently.
   */
  declaredBy: v.array(v.string()),
  /**
   * Which harnesses could serve it: the definition's own `harnesses` narrowed to the CLIs whose MCP
   * client reaches its transport. Free-form strings on purpose — these are CLI names
   * (`claude-code`, `codex`, `pi`), not translated copy, and duplicating kernel's closed
   * `HarnessKind` union here would be a second list to keep in step for no reader's benefit.
   *
   * EMPTY means the declaration can never run anywhere (an `http` server narrowed to `codex`, whose
   * client is stdio-only). Boot warns about that; it is repeated here because a boot warning is not
   * where anyone looks.
   */
  servableHarnesses: v.array(v.string()),
  /** The tools the agent may call, when the definition narrowed them. Absent ⇒ all of them. */
  allowedTools: v.optional(v.array(v.string())),
  /** The credentials it asks for, by name. */
  credentials: v.array(toolServerCredentialSchema),
  /**
   * The OAuth declaration's state for THIS workspace, when the server declares one. Absent ⇒ the
   * server authenticates with static credentials (or none), and the Connect affordance does not
   * apply to it at all.
   */
  oauth: v.optional(toolServerOAuthStatusSchema),
  /** Whether this deployment can reach the server to probe it. */
  probeable: v.boolean(),
  /** Why not, when `probeable` is false. Always present in that case, absent otherwise. */
  notProbeableReason: v.optional(toolServerNotProbeableReasonSchema),
})
export type ToolServerView = v.InferOutput<typeof toolServerViewSchema>

/** What the tool-server surface returns: every declaration this deployment registered. */
export const toolServersViewSchema = v.object({
  servers: v.array(toolServerViewSchema),
})
export type ToolServersView = v.InferOutput<typeof toolServersViewSchema>

/**
 * The verdict of one probe. A CLOSED vocabulary, and the members are split by the fix they call for
 * rather than by where in the code the failure happened:
 *
 * - `ok` — the server completed the MCP handshake and answered `tools/list`.
 * - `credentials_missing` — a `required` credential did not resolve, so nothing was sent. This is
 *   the same condition that makes a dispatch drop the server under `missing_secret`, reached
 *   without spending a run to find out.
 * - `credential_refused` — a credential's LOOKUP key names a platform configuration variable, so
 *   the probe refused to resolve it (the dispatch's `reserved_secret`). Kept apart from the above
 *   because setting the variable is precisely what must not help: the DECLARATION is what changes.
 * - `unreachable` — the request never got an answer (DNS, TLS, connection refused, timeout). The
 *   endpoint or the network is the fix.
 * - `http_error` — something answered with a status that is not an MCP response. `401`/`403` is the
 *   credential being wrong (as opposed to absent, which is `credentials_missing`); `404` is usually
 *   a url pointing at the wrong path. `httpStatus` carries which.
 * - `protocol_error` — it answered, but not as an MCP server: a non-JSON body, a JSON-RPC error, a
 *   protocol version it would not negotiate. The url probably names something that is not this
 *   server.
 * - `oauth_not_connected` — the declaration authenticates with OAuth and this workspace has not
 *   granted it. Kept apart from `credentials_missing` because there is no value to type: the
 *   remedy is the Connect flow, and an operator sent to the credential checklist would find no row.
 * - `oauth_token_failed` — a grant is on file and produced no access token (revoked or expired
 *   refresh, an authorization server that refused, discovery that failed). The dispatch reports
 *   the same condition as `oauth_token_failed`; `error` carries the cause.
 * - `not_probeable` — the probe was refused before it began; see
 *   {@link toolServerNotProbeableReasonSchema}.
 */
export const toolServerProbeStatusSchema = v.picklist([
  'ok',
  'credentials_missing',
  'credential_refused',
  'oauth_not_connected',
  'oauth_token_failed',
  'unreachable',
  'http_error',
  'protocol_error',
  'not_probeable',
])
export type ToolServerProbeStatus = v.InferOutput<typeof toolServerProbeStatusSchema>

/**
 * Whether the tools the definition NARROWED to actually exist on the server.
 *
 * The first thing in the platform that can answer it. `allowedTools` is held to a NAME pattern at
 * registration, at dispatch and at the job boundary, but no layer can check a well-formed name
 * against reality: a typo'd `search_issue` narrows claude-code's allow-list to a pattern matching
 * nothing while the prompt goes on advertising the name, which is the "told about a tool it cannot
 * call" failure the whole unavailability vocabulary exists to prevent.
 *
 * `checked` is why this is an object rather than a bare list. `tools/list` is PAGINATED, and the
 * probe reads a bounded number of pages; if a cursor was still outstanding, a name's absence from
 * what came back is not evidence it is absent from the server. So an unread tail makes the verdict
 * `checked: false` and `unmatched` empty, rather than reporting names as missing on the strength of
 * a partial read.
 */
export const toolServerAllowedToolsCheckSchema = v.object({
  declared: v.array(v.string()),
  /** Declared names the server does not expose. Empty when `checked` is false. */
  unmatched: v.array(v.string()),
  /** Whether the full tool list was read, and therefore whether `unmatched` means anything. */
  checked: v.boolean(),
})
export type ToolServerAllowedToolsCheck = v.InferOutput<typeof toolServerAllowedToolsCheckSchema>

/** What one probe answered. */
export const toolServerProbeResultSchema = v.object({
  serverId: v.string(),
  status: toolServerProbeStatusSchema,
  /** Present when `status` is `not_probeable`, absent otherwise. */
  notProbeableReason: v.optional(toolServerNotProbeableReasonSchema),
  /** The `serverInfo` the handshake returned. Present on `ok`. */
  serverName: v.optional(v.string()),
  serverVersion: v.optional(v.string()),
  /** The protocol version the server negotiated. Present on `ok`. */
  protocolVersion: v.optional(v.string()),
  /**
   * How many tools the server exposed across the pages that were read. Present on `ok`.
   *
   * Read WITH `toolsComplete`: a count off a truncated read is a floor, not a total, and the two
   * fields exist separately so the surface can say which it is holding.
   */
  toolCount: v.optional(v.number()),
  /** The tool names read, capped — see {@link MCP_PROBE_TOOL_NAME_CAP}. Present on `ok`. */
  tools: v.optional(v.array(v.string())),
  /** Whether every page of `tools/list` was read. Present on `ok`. */
  toolsComplete: v.optional(v.boolean()),
  /** The `allowedTools` reconciliation, when the definition narrowed them and the probe answered. */
  allowedTools: v.optional(toolServerAllowedToolsCheckSchema),
  /** Which declared credentials did not resolve. Present on `credentials_missing`. */
  unresolvedCredentials: v.optional(v.array(v.string())),
  /** Which declared credential named a platform variable. Present on `credential_refused`. */
  refusedCredentials: v.optional(v.array(v.string())),
  /** The status something answered with. Present on `http_error`. */
  httpStatus: v.optional(v.number()),
  /**
   * The failure in prose, for the disclosure behind the translated description. Scrubbed through
   * `redactSecrets` at the emit site: a fetch error routinely echoes the request url, and this one
   * carries a credential header.
   */
  error: v.optional(v.string()),
})
export type ToolServerProbeResult = v.InferOutput<typeof toolServerProbeResultSchema>

/**
 * What starting an OAuth grant answers: the vendor's own authorization URL, for the SPA to send
 * the operator to.
 *
 * A url handed back rather than a 302, because the caller is a `fetch` from the settings panel and
 * a redirect there would be followed by the browser into a cross-origin document the SPA cannot
 * observe. It also keeps the refusals (`503` when the redirect URL is unconfigured, `409` when the
 * declaration is not an `authorization_code` one) as ordinary error envelopes with a
 * `details.reason` the panel can translate, which a redirect response cannot carry.
 */
export const toolServerOAuthStartSchema = v.object({
  url: v.string(),
})
export type ToolServerOAuthStart = v.InferOutput<typeof toolServerOAuthStartSchema>

/**
 * What the SPA hands back to finish a grant: the two values the vendor put in the redirect it sent
 * the operator's browser to.
 *
 * POSTED BY THE SPA rather than read off a redirect the backend receives, and that is the whole
 * security shape of this flow. A vendor's redirect is a third-party browser navigation carrying no
 * `Authorization` header, so a backend route receiving it directly cannot know WHO is completing
 * the grant, and the session and permission checks such a route makes are unreachable code on any
 * deployment where sessions are bearer tokens. Landing the redirect on an SPA page that re-presents
 * these two values over the authenticated API is what makes the user binding and the
 * `secrets.manage` re-check real rather than decorative.
 *
 * Neither value is a secret this side minted: `code` is single-use at the authorization server and
 * `state` is sealed, so the pair is inert to anyone who cannot also open the seal.
 */
export const toolServerOAuthCompletionSchema = v.object({
  code: v.string(),
  state: v.string(),
})
export type ToolServerOAuthCompletion = v.InferOutput<typeof toolServerOAuthCompletionSchema>

/**
 * What completing a grant answers: which server was connected, so the page that finishes the flow
 * can name it before sending the operator back to the panel.
 *
 * The server id comes from the SEALED state rather than from anything the caller sent, which is
 * why it is worth returning at all: it is the one fact the SPA could not otherwise know, having
 * handed off to the vendor and come back on a fixed redirect URL that carries no board or server.
 */
export const toolServerOAuthCompletedSchema = v.object({
  serverId: v.string(),
  workspaceId: v.string(),
})
export type ToolServerOAuthCompleted = v.InferOutput<typeof toolServerOAuthCompletedSchema>

/**
 * How many tool NAMES a probe result carries back.
 *
 * The list is for recognition ("yes, that is the Slack server") and for the `allowedTools`
 * reconciliation, which is computed on the backend against everything read rather than against this
 * prefix — so capping the wire list narrows what a human scrolls and never what was checked.
 * `toolCount` states the real figure, so a truncated list is visible rather than implied.
 */
export const MCP_PROBE_TOOL_NAME_CAP = 100

/**
 * Pages of `tools/list` one probe reads before it stops and reports the read as incomplete.
 *
 * A bound rather than a full drain, because a probe is an interactive request an operator waits on
 * and the page size is the SERVER's choice: an unbounded loop hands a remote server control of how
 * long this endpoint runs. Three pages covers every real server's tool table; a cursor still
 * outstanding after the third means the answer is "it works, and it has more tools than this can
 * enumerate", which is a true and useful answer.
 */
export const MCP_PROBE_MAX_PAGES = 3

/** How long a probe waits for the whole handshake-plus-list exchange. */
export const MCP_PROBE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// The RUN-facing half: what one dispatch decided about the servers its agent kind declared.
//
// Everything above answers "what did this deployment register, and does it answer". This answers
// a different question, settled from a different source and at a different time: for THIS step,
// which declared servers were actually wired into the agent's CLI, and which were not, and why.
// Until now that decision reached exactly two readers, neither of them an operator: the agent's
// own prompt (which states the drops so it plans around them) and a backend `warn` line, plus an
// untyped id list in the agent-context snapshot's `extras` bag, which the observability panel
// renders as a JSON dump.
//
// It is a WIRE vocabulary rather than a kernel one because both sides have to agree about it: the
// engine writes it onto the step at dispatch, and the SPA renders each member as a chip with its
// own translated remedy. A reason the SPA cannot name is a blank chip on the one surface an
// operator opens to find out why their tool never showed up.
// ---------------------------------------------------------------------------

/**
 * Why a declared tool server was not wired into one dispatch. Mirrors kernel's
 * `UnavailableToolServer['reason']`, which carries the authoring-side prose for each member; the
 * two lists are pinned together by a conformity test in kernel, because a member added on one side
 * only renders as a chip with no copy.
 *
 * Split by the FIX each one calls for, never by where in the resolution the drop happened:
 * `missing_secret` is a value to supply and `reserved_secret` is a declaration to change;
 * `oauth_not_connected` is a person pressing Connect and `oauth_token_failed` is a grant that
 * stopped working; `harness_unsupported` is the wrong CLI for the server and
 * `transport_unsupported` is the right CLI reaching the wrong transport; `over_budget` is a kind
 * declaring more servers than a job body carries, with nothing wrong with the server at all.
 */
export const toolServerUnavailableReasonSchema = v.picklist([
  'harness_unsupported',
  'transport_unsupported',
  'missing_secret',
  'reserved_secret',
  'oauth_not_connected',
  'oauth_token_failed',
  'over_budget',
])
export type ToolServerUnavailableReason = v.InferOutput<typeof toolServerUnavailableReasonSchema>

/**
 * Whether a value is a reason this build knows.
 *
 * DERIVED from the picklist's own options rather than restated, and it exists because this
 * vocabulary is PERSISTED: a run recorded last month carries whatever members that build had, so a
 * member retired in a later one still arrives at a renderer whose exhaustive `Record` has no entry
 * for it. Narrowing through this keeps the compile-time totality (adding a member still fails the
 * build until it is named) while letting a retired one render as retired instead of as an empty
 * chip or a thrown `TypeError` in the panel an operator opened to read it.
 */
export function isToolServerUnavailableReason(
  value: unknown,
): value is ToolServerUnavailableReason {
  return (
    typeof value === 'string' &&
    (toolServerUnavailableReasonSchema.options as readonly string[]).includes(value)
  )
}

/**
 * One declared tool server, as ONE dispatch resolved it.
 *
 * `status` rather than a bare presence-or-absence list because the two halves answer the same
 * operator question and belong in one ordered record: a step that wired two of the three servers
 * its kind declares is a different fact from one that wired two and declares two, and a surface
 * reading two lists has to reconstruct that. `reason` is present exactly when `status` is
 * `unavailable`.
 */
export const dispatchedToolServerSchema = v.object({
  id: v.string(),
  /** The declaration's human label (its id when it declared none), for the chip. */
  label: v.string(),
  status: v.picklist(['wired', 'unavailable']),
  /** Why it was not wired. Present exactly when `status` is `unavailable`. */
  reason: v.optional(toolServerUnavailableReasonSchema),
})
export type DispatchedToolServer = v.InferOutput<typeof dispatchedToolServerSchema>

/**
 * What one dispatch decided about every tool server its kind declared, wired and dropped alike.
 *
 * ABSENT and EMPTY are deliberately different facts and only one of them is ever written: absent
 * means the kind declared no tool servers at all (every built-in agent on a stock deployment), so
 * the surface says nothing rather than showing an empty "MCP tool servers" heading on every step
 * of every run. A dispatch that resolved at least one declaration always writes the whole list.
 */
export const dispatchedToolServersSchema = v.array(dispatchedToolServerSchema)
