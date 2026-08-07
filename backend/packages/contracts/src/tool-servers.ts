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
 * Why a declared tool server did NOT reach one dispatch.
 *
 * The vocabulary kernel's `UnavailableToolServer` is typed against, held here because both sides
 * have to agree about it: the container executor decides a member, and the SPA maps each one to
 * translated copy on the run surface. Leaving the union in kernel, which the SPA cannot see, would
 * make the SPA's mapping a hand-written duplicate of a closed list, and a member added on one side
 * only renders as a blank chip on the other.
 *
 * Every member names a DIFFERENT fix, which is why they are not folded together. The reasoning per
 * member lives on kernel's `UnavailableToolServer`, which is where a dispatch chooses one; what
 * matters here is that the list is CLOSED and PERSISTED (it lands on `PipelineStep.toolServers`
 * and outlives the run), so a member retired later has to be RENDERED as retired rather than
 * dropped: a reader hitting a stale value is by construction the surface whose whole job is
 * naming what an operator must go and fix.
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
 * What one dispatch did with the tool servers its agent kind declared, recorded on the step.
 *
 * Two lists rather than one list with a status, because they are not two states of one thing: a
 * WIRED server is a capability the prompt promised the agent, while an UNAVAILABLE one is a
 * promise the platform deliberately withheld and stated instead. A reader filtering a mixed list
 * by status would get the same answer; a reader who forgot to filter would report a dropped server
 * as a working one, which is the exact failure the unavailability vocabulary exists to prevent.
 *
 * Composed at DISPATCH, not read back from the container: the harness materialises what this
 * decided, and the poll site rebuilds the job handle from the step alone, so nothing downstream
 * can re-derive it (see `recordDispatchAttribution`).
 *
 * ABSENT and `{ wired: [], unavailable: [] }` are different states and both are load-bearing:
 * absent means the step's CURRENT attempt holds no dispatch-recorded resolution (an inline step, a
 * run that predates the field, or a step re-armed for a re-run and not yet re-dispatched), while
 * both-empty means a dispatch ran and its kind declared no tool servers at all. The diagnostic
 * weight survives that third case: a step which lost every server it declared still never reads as
 * one that declared none.
 *
 * What absent does NOT say is that the step never ran. `resetStepForRerun` clears this field while
 * leaving `attempts` and `dispatches` standing, and that asymmetry is deliberate: the counters are
 * the record that the step ran before, while this describes ONE resolution against one harness, one
 * secret resolver and one set of OAuth grants. A re-run resolves afresh against whatever the
 * deployment now wires, so a reader asking what the step HAS is asking about the live attempt, and
 * a re-armed step holding the previous round's answer would name servers nothing will ask for.
 */
/**
 * The state the agent's CLI gave one tool server when it started up.
 *
 * A CLOSED vocabulary normalised by the harness from the CLI's OWN open one, which is why
 * `unknown` is a member rather than a dropped row: the CLI's status words belong to a third party
 * that may add to them, and a server whose state this platform cannot name is still a server the
 * CLI knew about. Reporting it as `ready` would dress a dead tool up as a live one, and dropping
 * it reads as a server the CLI never loaded — a different fact with a different fix.
 *
 * - `ready` — loaded and connected. Its tools were available to the agent.
 * - `failed` — the CLI could not bring it up. The prompt promised its tools and they never existed.
 * - `needs_auth` — the server answered, and refused the credential (or asked for one that never
 *   arrived). Separate from `failed` because the fix is a credential or an OAuth reconnect rather
 *   than the endpoint or the package.
 * - `unknown` — the CLI named a state this platform's mapping does not cover.
 *
 * PERSISTED and closed, so a member retired later must be RENDERED as retired rather than dropped
 * (the same rule the unavailability vocabulary above carries, for the same reason).
 */
export const toolServerObservedStatusSchema = v.picklist([
  'ready',
  'failed',
  'needs_auth',
  'unknown',
])
export type ToolServerObservedStatus = v.InferOutput<typeof toolServerObservedStatusSchema>

/**
 * Whether a reported status is a member of the vocabulary — DERIVED from the picklist's own
 * options, so it cannot drift from it the way a hand-written second list would.
 *
 * The narrowing every producer of this field needs: the value arrives from an agent CLI, through
 * the harness's normalisation, over a job-view hop, and the engine has to place it in a closed
 * union without either trusting it or reaching for valibot in a package that does not depend on
 * it. The negative case is `unknown`, which the vocabulary carries precisely so this narrowing
 * has an honest answer to give.
 */
export function isToolServerObservedStatus(value: unknown): value is ToolServerObservedStatus {
  return typeof value === 'string' && TOOL_SERVER_OBSERVED_STATUS_SET.has(value)
}

const TOOL_SERVER_OBSERVED_STATUS_SET: ReadonlySet<string> = new Set(
  toolServerObservedStatusSchema.options,
)

/** One server's line in the CLI's own startup report. See {@link stepToolServersSchema}'s `observed`. */
export const observedToolServerSchema = v.object({
  id: v.string(),
  status: toolServerObservedStatusSchema,
  /**
   * How many tools the CLI exposed for this server.
   *
   * ABSENT and `0` are different facts, and conflating them is the mistake this field exists to
   * avoid: absent means the CLI listed no tools at all so nothing was counted, while `0` means it
   * listed its tools and this server contributed none — a server that connected and offers
   * nothing, which reaches the agent exactly like one that was never wired and is otherwise
   * indistinguishable from a healthy connection.
   */
  toolCount: v.optional(v.number()),
})
export type ObservedToolServer = v.InferOutput<typeof observedToolServerSchema>

export const stepToolServersSchema = v.object({
  /** The servers whose transport, harness and credentials all resolved, so the agent could call them. */
  wired: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      transport: toolServerTransportSchema,
      /**
       * The tools the definition narrowed the agent to. Absent ⇒ every tool the server exposes.
       * Recorded because a narrowed list is the likeliest reason a working server produced no
       * useful call, and the declaration can be edited after the run.
       */
      tools: v.optional(v.array(v.string())),
    }),
  ),
  /** The servers the kind declared and this dispatch dropped, each with the reason it was dropped. */
  unavailable: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      reason: toolServerUnavailableReasonSchema,
    }),
  ),
  /**
   * The agent kind whose declarations these two lists describe: the kind that was DISPATCHED, not
   * necessarily the kind the step is named for.
   *
   * Required, because a step's own `agentKind` is routinely not what ran: a `ci` gate escalates to
   * `ci-fixer`, a tester hands off to `fixer`, a two-phase coder dispatches twice. Each of those
   * re-dispatches resolves its OWN kind's declarations and overwrites this record, so without the
   * kind stamped on it the lists would be read under the step's kind and describe a different
   * agent's capabilities. The engine stamps it from the same `dispatchedKind` that feeds
   * `step.dispatches`, so an executor cannot mislabel it.
   */
  agentKind: v.string(),
  /**
   * What the agent's CLI reported about the servers it actually loaded, folded from the run's
   * polls beside what the platform decided above.
   *
   * The two halves answer different questions and neither substitutes for the other: `wired` and
   * `unavailable` are the PLATFORM's account of what it promised the agent and what it withheld,
   * decided before the container started; this is the CLI's account of what it managed to start.
   * A vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
   * vendor revoked between dispatch and launch — all of them leave a server in `wired` and a
   * prompt promising a tool nothing can call, and this is the only place that shows up.
   *
   * ABSENT means no observation was made, NOT that nothing was observed: the run's harness never
   * reported (codex's CLI publishes no such report, and neither does any image older than the one
   * that introduced this), or the step is inline, or it has been re-armed for a re-run. So a
   * reader may never conclude from an absent field that a wired server failed. Never persisted
   * empty for the same reason — the producer omits it rather than sending `[]`.
   *
   * A `wired` id MISSING from a present list is meaningful in the other direction: the CLI
   * announced its servers and did not name this one, so it was never loaded at all.
   */
  observed: v.optional(v.array(observedToolServerSchema)),
})
export type StepToolServers = v.InferOutput<typeof stepToolServersSchema>

/**
 * What a dispatch RESOLVED, before the engine attributes it to the kind that ran.
 *
 * A type rather than a schema of its own: it never crosses a wire, so there is nothing to
 * validate. It is what an executor puts on its job handle and what
 * `recordDispatchAttribution` stamps the kind onto, and deriving it from {@link StepToolServers}
 * keeps the two structurally impossible to drift.
 */
export type DispatchToolServers = Omit<StepToolServers, 'agentKind'>

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
