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
 * - `not_probeable` — the probe was refused before it began; see
 *   {@link toolServerNotProbeableReasonSchema}.
 */
export const toolServerProbeStatusSchema = v.picklist([
  'ok',
  'credentials_missing',
  'credential_refused',
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
 * long this endpoint runs. Two pages is enough for every real server's tool table; a third page
 * means the answer is "it works, and it has more tools than this can enumerate", which is a true
 * and useful answer.
 */
export const MCP_PROBE_MAX_PAGES = 3

/** How long a probe waits for the whole handshake-plus-list exchange. */
export const MCP_PROBE_TIMEOUT_MS = 10_000
