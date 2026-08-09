import type { ToolServerUnavailableReason } from '@cat-factory/contracts'
import type { HarnessKind } from '../ports/model-provider.js'

// ---------------------------------------------------------------------------
// Agent CAPABILITIES — the skills an agent applies and the tool servers (MCP) it may call.
//
// Both are vocabulary an agent kind DECLARES and the engine resolves per dispatch, so this
// module holds the shapes that cross the layers: the agent-kind registry (`@cat-factory/agents`)
// declares them, the engine (`AgentContextBuilder`) resolves them onto `AgentRunContext`, the
// container executor renders them harness-aware into the job body, and the harness materialises
// them for the CLI it runs.
//
// The split that matters: a RESOLVED capability on `AgentRunContext` is PROMPT-FACING and
// therefore non-secret (the agent-context telemetry snapshot copies it verbatim). A tool
// server's credentials never appear here — they are resolved at dispatch straight into the
// job body's dedicated top-level field, exactly like the tester's `testSecrets`.
// ---------------------------------------------------------------------------

/** One resource file of a skill, fetched at the skill's pinned commit. */
export interface ResolvedSkillResource {
  /** Repo-relative path (used to reference an un-materialised resource in the prompt). */
  path: string
  /** Path within the skill directory (where it materialises, under the skill / `.cat-context/skill`). */
  relPath: string
  /** File body; absent when the resource was oversized / binary / unreadable at dispatch. */
  body?: string
}

/**
 * A skill resolved for one dispatch — the procedural instructions (a `SKILL.md` body) plus its
 * sibling resources. Two origins produce the identical shape, so nothing downstream branches on
 * where a skill came from:
 *
 * - **catalog** — a repo-sourced skill synced into the account's skill catalog (ADR 0024),
 *   picked per step (`stepOptions.skillId`) or declared by an agent kind.
 * - **bundled** — a skill shipped IN CODE by the deployment's agent package and registered on
 *   the `AgentKindRegistry`. It needs no repo, no sync and no GitHub connection, which is what
 *   makes a custom agent kind's own playbook installable on a deployment that has no skill
 *   library configured at all.
 */
export interface ResolvedSkill {
  /** The skill id — `src:<sourceId>:<dirName>` for a catalog skill, the registered id for a bundled one. */
  skillId: string
  /** Where the skill came from (a bundled skill is never version-pinned — its version is the deployment's). */
  origin: 'catalog' | 'bundled'
  /** Skill name (the native CLI skill directory name + the `SKILL.md` frontmatter `name`). */
  name: string
  /** One-line description (the `SKILL.md` frontmatter `description`; feeds the native manifest). */
  description: string
  /** The procedural instructions — the `SKILL.md` body. */
  instructions: string
  /** Sibling resource files (capped; oversized/binary/unreadable ones omit `body`). */
  resources: ResolvedSkillResource[]
}

/** The per-run version pin recorded on a step for a CATALOG skill (a bundled skill has none). */
export interface SkillVersionPin {
  skillId: string
  commit: string | null
  sha: string
}

// ---------------------------------------------------------------------------
// Tool servers (MCP)
// ---------------------------------------------------------------------------

/** A tool server the harness starts as a child process inside the run container. */
export interface McpStdioTransport {
  kind: 'stdio'
  command: string
  args?: string[]
  /** Non-secret environment for the server process. Secrets ride {@link McpServerDefinition.secretKeys}. */
  env?: Record<string, string>
}

/** A tool server the agent CLI reaches over HTTP (streamable HTTP / SSE endpoint). */
export interface McpHttpTransport {
  kind: 'http'
  url: string
  /** Non-secret headers. A credential header is produced from a resolved secret instead. */
  headers?: Record<string, string>
}

export type McpTransport = McpStdioTransport | McpHttpTransport

/**
 * A secret a tool server needs, declared by NAME only. The value is resolved at dispatch by the
 * facade-wired {@link import('../ports/agent-tools.js').ToolSecretResolver} and injected straight
 * into the job body — it never reaches `AgentRunContext`, a prompt, or the telemetry snapshot.
 */
export interface McpSecretRef {
  /**
   * The secret's LOOKUP key: the name the facade-wired resolver is asked for, and the name a
   * workspace stores its own value under.
   *
   * It may NOT name a variable the platform's own configuration owns (`isReservedPlatformEnvKey`
   * in `@cat-factory/contracts`). The default resolver reads the key straight off the deployment's
   * environment, and a definition names both the key it wants AND the endpoint that key is sent
   * to. Boot validation refuses one, and dispatch refuses it again for the mothership case, where
   * the definition was authored by a process that is not this one.
   *
   * For a `stdio` server this is also the environment variable of the server process, unless
   * {@link McpSecretRef.envName} says otherwise. For an `http` server the resolved value is sent
   * as the {@link McpSecretRef.header} request header (shaped by
   * {@link McpSecretRef.headerTemplate}), so the lookup name is already separate from where the
   * value goes.
   */
  key: string
  /**
   * `stdio` only: the environment variable the value is set as in the SERVER's process, when that
   * differs from {@link McpSecretRef.key}. Omitted, the key is used.
   *
   * This exists because a server's own client usually reads a documented variable name that the
   * platform cannot rename, and some of those names fall inside a platform prefix family: the
   * GitHub MCP server reads `GITHUB_PERSONAL_ACCESS_TOKEN`, which `GITHUB_` reserves even though
   * the platform reads no such variable. Splitting the two names resolves that without weakening
   * the floor, because the floor is about what may be READ off the deployment's environment and
   * this name reads nothing:
   *
   *     { key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }
   *
   * Held to its own, narrower rule instead (`isToolchainEnvName`): a value injected as `PATH` or
   * `npm_config_registry` reconfigures the process rather than authenticating a call. Refused at
   * registration, and dropped at dispatch.
   */
  envName?: string
  /**
   * `http` only: the request header the value is sent as (e.g. `Authorization`). The value is
   * substituted into {@link headerTemplate}. Omitted ⇒ the secret is passed as an env var, which
   * an `http` server has no use for, so declare one for an HTTP tool server.
   */
  header?: string
  /**
   * The header value template, with `{value}` standing in for the secret (e.g. `Bearer {value}`).
   * Omitted ⇒ the bare value. Only meaningful alongside {@link header}.
   */
  headerTemplate?: string
  /**
   * When true, the tool server is DROPPED (with a note in the prompt) if this secret does not
   * resolve. Defaults to true: a tool that will fail on its first call is worse than one the
   * agent was told it does not have. Set false for a genuinely optional credential.
   */
  required?: boolean
  /**
   * One line telling the OPERATOR what value to put here and where to get it (a vendor's token
   * page, the scopes it needs). Rendered beside the key in the capability-credential checklist.
   *
   * The checklist can only ever say what the DECLARATION says. Without this it names a variable
   * and the capability that wants it, which for a house server the operator wrote is enough and
   * for `SLACK_MCP_TOKEN` is not: nothing on the surface says whether that is a bot token, a user
   * token, or which scopes it needs, so the operator goes back to the deployment's source — the
   * exact trip the checklist exists to remove. The generative-integration half of this vocabulary
   * has carried the field since it landed; a tool server's credential simply had nowhere to put it.
   *
   * Non-secret and operator-facing: it is rendered in the SPA, so it must name no value.
   */
  usage?: string
}

/**
 * How a REMOTE (`http`) tool server's access token is obtained, when the server authenticates with
 * OAuth 2.1 rather than a static credential.
 *
 * This is the declaration half only: the deployment states which OAuth client it is and what it
 * wants, and everything mutable (the tokens, their expiry, the refresh) lives per WORKSPACE in the
 * sealed grant store. That split is deliberate and mirrors {@link McpSecretRef}: a static
 * credential's declaration is a key NAME and its value is per-tenant, and an OAuth credential's
 * declaration is a client and its GRANT is per-tenant. A deployment therefore registers a vendor's
 * remote server once, and each board authorises its own account against it.
 *
 * The two grants cover the two shapes a remote server comes in, and they differ in whether a HUMAN
 * is involved at all, which is why they are one field rather than two definitions:
 *
 * - `authorization_code` — the vendor case (Linear, Atlassian, Figma). Someone with
 *   `secrets.manage` presses Connect, authorises in the vendor's own UI, and the workspace holds
 *   the resulting refresh token. PKCE is always used, so a PUBLIC client (no
 *   {@link McpOAuthConfig.clientSecretKey}) is a supported and common shape.
 * - `client_credentials` — a machine grant against an internal or partner server. No browser, no
 *   grant UI, nothing per-tenant except the client secret: the token is minted on demand and
 *   cached in the same store. This is what makes an OAuth-protected INTERNAL server reachable on a
 *   deployment that has no one to press a button (a cron-driven install, a CI environment).
 */
export interface McpOAuthConfig {
  grant: 'authorization_code' | 'client_credentials'
  /**
   * The OAuth client id this deployment registered with the server's authorization server.
   *
   * Static on purpose: dynamic client registration (RFC 7591) is not performed, because a
   * client registered at runtime is deployment state with no home in a composition-root
   * registration and no operator-visible identity at the vendor. Register the client once in the
   * vendor's console and name it here.
   */
  clientId: string
  /**
   * The LOOKUP key for the client SECRET, resolved through the very same `ToolSecretResolver`
   * chain a {@link McpSecretRef} uses — so a workspace can bring its own OAuth client through the
   * capability-credential checklist, and a single-tenant deployment can set an environment
   * variable, with no second credential mechanism to learn.
   *
   * Omitted ⇒ a PUBLIC client: the token requests carry the client id and PKCE and no secret,
   * which is what most remote MCP servers expect. Held to the same reserved-key floor as every
   * other capability credential (`isReservedPlatformEnvKey`), for the same reason: a definition
   * names both the key it wants and the endpoint that key is sent to.
   */
  clientSecretKey?: string
  /**
   * The authorization endpoint. Omitted ⇒ DISCOVERED from the server url (RFC 9728 protected
   * resource metadata, then RFC 8414 authorization-server metadata), which is what the MCP
   * authorization spec prescribes and what makes a vendor server connectable without an operator
   * hunting endpoint URLs out of a changelog.
   *
   * Declared, it WINS over discovery: a deployment that pins its endpoints is stating that it does
   * not want a third party's metadata document deciding where its tokens are sent.
   */
  authorizationUrl?: string
  /** The token endpoint. Omitted ⇒ discovered, as {@link McpOAuthConfig.authorizationUrl}. */
  tokenUrl?: string
  /** Scopes requested at authorization. Omitted ⇒ whatever the server grants by default. */
  scopes?: string[]
  /**
   * The RFC 8707 `resource` indicator sent with the authorization and token requests, which the
   * MCP authorization spec requires so a token minted for one MCP server cannot be replayed
   * against another behind the same authorization server. Omitted ⇒ the server's own url, which is
   * the right answer whenever the server is its own resource.
   */
  resource?: string
  /**
   * The request header the access token rides, and its template. Default `Authorization` /
   * `Bearer {value}`, which is what every OAuth-protected MCP server expects; the override exists
   * for a gateway that reads the token somewhere else, exactly as {@link McpSecretRef.header} does.
   */
  header?: string
  headerTemplate?: string
}

/** The header an OAuth access token rides when the declaration does not say otherwise. */
export const MCP_OAUTH_DEFAULT_HEADER = 'Authorization'
/** The template that header's value uses when the declaration does not say otherwise. */
export const MCP_OAUTH_DEFAULT_HEADER_TEMPLATE = 'Bearer {value}'

/**
 * A tool server (MCP) an agent kind can be given. Registered on the `AgentKindRegistry` by id and
 * referenced from any number of kinds, or declared inline on a single kind.
 *
 * Deployment-STATIC data (a composition-root registration), exactly like an agent kind itself —
 * the per-tenant half is the credential, which is resolved through the `ToolSecretResolver` port.
 */
export interface McpServerDefinition {
  /**
   * Stable id, used as the MCP server NAME the CLI exposes tools under (`mcp__<id>__<tool>`), so
   * it must be a safe identifier — see {@link isValidMcpServerId}.
   */
  id: string
  /** Human label for the prompt section + the run's diagnostics. Defaults to the id. */
  label?: string
  /**
   * One or two sentences telling the agent WHAT this server is for and when to reach for it,
   * folded into the prompt's tool-server section. Without it an agent tends to ignore a tool it
   * was handed, so this is the difference between a wired server and a used one.
   */
  guidance?: string
  transport: McpTransport
  /**
   * Restrict which of the server's tools the agent may call (bare tool names, e.g. `search_issues`).
   * Omitted ⇒ every tool the server exposes.
   *
   * This is SCOPING, not a security boundary. It is always stated in the prompt (every harness),
   * and additionally passed to the claude-code CLI's `--allowedTools` — but the run's permission
   * mode decides whether the CLI treats that list as a gate at all, and Codex's config cannot
   * express a per-tool restriction. A server whose other tools an agent kind must genuinely never
   * reach should not be wired for that kind at all, rather than wired and narrowed.
   *
   * Each name is held to {@link isValidMcpToolName}, because the harness JOINS the list into one
   * `--allowedTools` argument with commas: a name carrying a comma or whitespace would split into
   * two entries matching nothing.
   */
  allowedTools?: string[]
  /**
   * Which harnesses can serve this server. Defaults to {@link MCP_SUPPORTED_HARNESSES} — the CLIs
   * that speak MCP. A run on a harness outside the list keeps working; the server is dropped and
   * the prompt says so, rather than the agent being told about a tool it cannot call.
   *
   * Narrowing this is NOT how a TRANSPORT restriction is expressed: which transports a CLI can
   * reach is a fact about the CLI, held in {@link MCP_HARNESS_TRANSPORTS} and applied on top of
   * this list. See {@link mcpServableHarnesses}.
   */
  harnesses?: HarnessKind[]
  /** Credentials the server needs, by name. Resolved at dispatch; never rendered into a prompt. */
  secretKeys?: McpSecretRef[]
  /**
   * OAuth, for a remote server that authenticates with a granted token rather than a static one.
   * `http` transport only — a `stdio` server is a child process with no request to authorise, and
   * boot validation refuses the combination rather than letting it read as configured.
   *
   * Composes with {@link McpServerDefinition.secretKeys} rather than replacing them: a server may
   * want a granted token AND a static tenant header, and each rides the channel its own
   * declaration named. The access token's header is the one place they can collide, which boot
   * validation names.
   */
  oauth?: McpOAuthConfig
}

/**
 * The prompt-facing projection of a tool server that was actually wired for this dispatch. Carried
 * on `AgentRunContext` (so it IS captured in the agent-context snapshot) and therefore free of
 * every credential.
 */
export interface ResolvedToolServer {
  id: string
  label: string
  guidance?: string
  /** The tools the agent may call, when the definition restricted them. Absent ⇒ all of them. */
  tools?: string[]
  /** Transport kind, so the prompt can say whether the tool is local to the container or remote. */
  transport: McpTransport['kind']
}

/**
 * A tool server that was declared but NOT wired for this dispatch, with the reason — surfaced in
 * the prompt so the agent plans around a missing tool instead of discovering it mid-run, and in
 * the run's context snapshot so an operator can see why.
 */
export interface UnavailableToolServer {
  id: string
  label: string
  /**
   * Each member names a DIFFERENT fix, which is why they are not folded together:
   *
   * - `reserved_secret` is kept apart from `missing_secret` because a missing secret is a variable
   *   to SET, while a reserved one is a DECLARATION to change: the server named a variable the
   *   platform's own configuration owns, and setting it is exactly what must not help.
   * - `unusable_secret` is kept apart from both: the value RESOLVED and has nowhere to go, because
   *   the declaration named a channel its transport does not have (see
   *   {@link mcpTransportCarriesCredential}). Setting the variable does not help and neither does
   *   changing the key; the channel is what changes. Boot validation refuses such a declaration, so
   *   a dispatch reaches this only where the definition was authored by a process that is not the
   *   one that booted (mothership mode, where a node runs one build behind).
   * - `transport_unsupported` is kept apart from `harness_unsupported` for the same reason: the
   *   harness DOES speak MCP and the definition DOES allow it, but this CLI's client cannot reach
   *   this transport (Codex is stdio-only). The fix is a second server declaration or a narrowed
   *   `harnesses` list, not a different harness.
   * - `over_budget` says the server was declared, servable and credentialed, and lost to a cap.
   *   Nothing about the server is wrong; the KIND declares more than a job body carries.
   * - `oauth_not_connected` is kept apart from `missing_secret` because the fix is not a value to
   *   type: nobody has AUTHORISED this workspace against the server yet, and the remedy is a
   *   person pressing Connect and signing in at the vendor. An operator who read "credential not
   *   configured" would go looking for a variable that does not exist.
   * - `oauth_token_failed` says a grant (or a client-credentials client) IS on file and the
   *   platform could not turn it into an access token: a revoked or expired refresh token, an
   *   authorization server that would not answer, a rotated client secret. Apart from
   *   `oauth_not_connected` because "never connected" and "the connection stopped working" send an
   *   operator to different places, and only the second is ever transient.
   * - `consensus_panel` is the only member decided by NO dispatch to a CLI at all: the step was
   *   diverted to a multi-model consensus panel, whose participants are inline model calls with no
   *   checkout, no CLI and therefore nowhere to wire an MCP server. Kept apart from
   *   `harness_unsupported` because nothing about the harness is involved: the kind's standard
   *   surface may serve the server perfectly, and the same step without consensus would have got
   *   it. The fix is a step-level choice (turn consensus off for this step, or accept the panel's
   *   ceiling), which is nobody's list to widen and no credential to set.
   *
   * ONE MEMBER IS NOT ONE CAUSE, and anyone writing operator-facing copy off this list has to
   * read the whole of a member before naming a fix for it. Three of them are reached from more
   * than one place, so a remedy addressing only the obvious cause is a dead end for whoever hit
   * the other:
   *
   * - `harness_unsupported` covers a CLI with no MCP client (Pi), a definition whose `harnesses`
   *   excludes the resolved one, AND an ambient-auth Codex run, which is reached only AFTER both
   *   of those tests passed. There the CLI does speak MCP and is allowed; what is missing is a
   *   per-run `CODEX_HOME`, so widening the list or switching CLI fixes nothing and only a leased
   *   credential in place of the developer's own login does.
   * - `missing_secret` is one answer from a COMPOSED resolver. The deployment-environment
   *   resolver is what both facades wire by default and a per-workspace credential store sits in
   *   front of it only where one is wired, so copy naming just the store sends a store-less
   *   deployment to a surface it does not have.
   * - `oauth_not_connected` covers a workspace that holds no grant AND a deployment with no grant
   *   store at all (no `ENCRYPTION_KEY`), where there is nowhere to keep one and connecting
   *   cannot be the whole answer.
   *
   * The member LIST itself lives in `@cat-factory/contracts`, not here, because the run surface
   * has to state the same judgement to a human and the SPA cannot see kernel: a union restated on
   * both sides drifts into a member that renders as a blank chip. Which member a dispatch picks is
   * still decided here.
   */
  reason: ToolServerUnavailableReason
}

/**
 * Which MCP transports each harness's CLI can actually reach. An exhaustive `Record` over
 * `HarnessKind`, so a new harness cannot be added without stating its answer: an omitted entry
 * would read as "no transports" and silently drop every tool server on that harness.
 *
 * Pi has no MCP client at all (hence the empty list, which is what keeps it out of
 * {@link MCP_SUPPORTED_HARNESSES}); Codex's client is stdio-only, which is why an `http` server on
 * a Codex run is DROPPED with a stated reason rather than advertised in the prompt and then skipped
 * by the harness's TOML writer.
 */
export const MCP_HARNESS_TRANSPORTS: Record<HarnessKind, readonly McpTransport['kind'][]> = {
  pi: [],
  'claude-code': ['stdio', 'http'],
  codex: ['stdio'],
}

/**
 * The harnesses whose CLI speaks MCP. DERIVED from {@link MCP_HARNESS_TRANSPORTS} rather than
 * listed again, so "speaks MCP" and "can reach at least one transport" cannot drift into
 * disagreeing. Pi has no MCP client, so it is absent.
 */
export const MCP_SUPPORTED_HARNESSES: readonly HarnessKind[] = (
  Object.keys(MCP_HARNESS_TRANSPORTS) as HarnessKind[]
).filter((harness) => MCP_HARNESS_TRANSPORTS[harness].length > 0)

/**
 * Whether a tool server can run on this harness: its own `harnesses` allow-list when it declared
 * one, else the CLIs that speak MCP at all. A definition may NARROW the default (a server that
 * only makes sense under one CLI) but never widen it — a harness with no MCP client cannot be
 * taught one by a registration.
 *
 * This answers the DECLARATION half only. Whether the harness can reach the definition's transport
 * is {@link mcpHarnessServesTransport}, and {@link mcpServableHarnesses} is both together.
 */
export function mcpServerSupportsHarness(
  definition: Pick<McpServerDefinition, 'harnesses'>,
  harness: HarnessKind,
): boolean {
  if (!MCP_SUPPORTED_HARNESSES.includes(harness)) return false
  return definition.harnesses ? definition.harnesses.includes(harness) : true
}

/** Whether this harness's MCP client can reach a server over `transport`. */
export function mcpHarnessServesTransport(
  harness: HarnessKind,
  transport: McpTransport['kind'],
): boolean {
  return MCP_HARNESS_TRANSPORTS[harness].includes(transport)
}

/**
 * The two ways a resolved credential can reach a tool server: as a variable of the server's own
 * process, or as a header on the request to it.
 */
export type McpCredentialChannel = 'env' | 'header'

/**
 * The ONE channel each transport can carry a credential over. An exhaustive `Record`, so a third
 * transport cannot be added without stating its answer.
 *
 * A `stdio` server is a child process the harness spawns, and there is no request to put a header
 * on. An `http` server is a URL the CLI calls, and there is no process to set a variable in. So the
 * channel is not a preference the declaration expresses: the transport fixes it, and a credential
 * that named the other one reaches NOTHING at all.
 */
export const MCP_TRANSPORT_CREDENTIAL_CHANNEL: Record<McpTransport['kind'], McpCredentialChannel> =
  {
    stdio: 'env',
    http: 'header',
  }

/**
 * Which channel a credential DECLARATION names: `header` when it named one, else the server
 * process's environment (under {@link McpSecretRef.envName}, or the lookup key).
 */
export function mcpCredentialChannel(secret: Pick<McpSecretRef, 'header'>): McpCredentialChannel {
  return secret.header ? 'header' : 'env'
}

/**
 * Whether the transport can actually deliver this credential: the channel the declaration named,
 * against the one the transport has.
 *
 * FALSE is the silent-failure case the platform must refuse rather than resolve. Both projections
 * that build a job body select by channel (`env` keys into the child process's environment, `header`
 * keys into the request headers), so a mismatched declaration resolves successfully, is folded into
 * nothing, and leaves the server WIRED, advertised to the agent, and started unauthenticated. The
 * first evidence is the agent's first tool call failing, several minutes into a run that the prompt
 * promised the tool for.
 *
 * Boot validation refuses such a declaration as an error, and dispatch refuses it again for the
 * mothership case, where the definition was authored by a process that is not this one. Both ask
 * THIS function, so the two cannot drift into disagreeing about which declarations work.
 */
export function mcpTransportCarriesCredential(
  transport: McpTransport['kind'],
  secret: Pick<McpSecretRef, 'header'>,
): boolean {
  return mcpCredentialChannel(secret) === MCP_TRANSPORT_CREDENTIAL_CHANNEL[transport]
}

/**
 * Every harness that could serve this definition: what it allows, intersected with the harnesses
 * whose client reaches its transport.
 *
 * EMPTY means the definition can never run anywhere: an `http` server narrowed to `harnesses:
 * ['codex']`, or anything narrowed to `['pi']`. That is dead configuration a run cannot report
 * (nothing was ever going to be dropped for a REASON; the server simply never applies), so boot
 * validation is the only place it can be named.
 */
export function mcpServableHarnesses(
  definition: Pick<McpServerDefinition, 'harnesses' | 'transport'>,
): HarnessKind[] {
  return MCP_SUPPORTED_HARNESSES.filter(
    (harness) =>
      mcpServerSupportsHarness(definition, harness) &&
      mcpHarnessServesTransport(harness, definition.transport.kind),
  )
}

/**
 * Bounds on the tool servers ONE dispatch carries, mirroring `CONTEXT_BUDGET`'s discipline for the
 * linked-context corpus: the job body is a single HTTP payload, and a kind that accretes servers
 * (its own declarations plus every `assignToolServers` call a deployment makes) bloats every
 * dispatch of that kind with config the agent has no room to use.
 *
 * The disposition differs from the context corpus on purpose. A context file is HUMAN-attached, so
 * an over-budget corpus refuses the dispatch and lets the person decide; tool servers are
 * DEPLOYMENT CODE, and refusing a run for a registration fault would take the deployment down for
 * something boot validation already warned about. So the excess is dropped under `over_budget`
 * (stated to the agent like every other drop), and BOTH dimensions are what the boot warnings
 * count against: see {@link toolServerDeclaredBytes} for the byte half, which boot can only
 * measure as a floor.
 */
export const TOOL_SERVER_BUDGET = {
  /** Max tool servers wired into one dispatch. */
  maxServers: 12,
  /** Total bytes of the serialised `mcpServers` job-body field (~32 KB). */
  maxTotalBytes: 32_768,
  /**
   * Max servers the prompt NAMES as unavailable before it summarises the remainder as a count.
   *
   * The drop list is unbounded where the wired list is capped, so the pathological declaration
   * `maxServers` exists to bound would otherwise land in the prompt anyway, one line per server.
   * The data stays whole (every drop is still on the run context, so the telemetry snapshot and an
   * operator read see all of them); only the rendering is bounded, and it says how many it folded.
   */
  maxStatedUnavailable: 12,
} as const

/**
 * The bytes ONE declaration contributes to the `mcpServers` job-body field, counting only the
 * fields that actually ride it: the id, the transport and its config, and `allowedTools`.
 *
 * A FLOOR, deliberately, and the only measure available before a dispatch: `label`, `guidance` and
 * `secretKeys` stay behind (the first two go to the prompt, the third is a name list resolved into
 * values), and a resolved credential only ADDS to what is counted here. That makes it sound for a
 * boot warning ("this declaration is already past the budget") while the dispatch keeps measuring
 * the resolved spec it really sends. A new job-body field left out of this count keeps it a floor,
 * which is why the two are allowed to be different measures rather than one shared one.
 */
export function toolServerDeclaredBytes(definition: McpServerDefinition): number {
  const transport =
    definition.transport.kind === 'stdio'
      ? {
          command: definition.transport.command,
          args: definition.transport.args,
          env: definition.transport.env,
        }
      : { url: definition.transport.url, headers: definition.transport.headers }
  const body = {
    id: definition.id,
    transport: definition.transport.kind,
    ...transport,
    allowedTools: definition.allowedTools,
  }
  return utf8ByteLength(JSON.stringify(body))
}

/**
 * The UTF-8 byte length of a string, counted rather than encoded: kernel is runtime-neutral and
 * compiled against neither DOM nor Node types, so it has no `TextEncoder` or `Buffer` to reach for.
 *
 * `string.length` would not do instead. It counts UTF-16 units, so a CJK or emoji-bearing config
 * value reads as a THIRD to a HALF of the bytes it will occupy, and a budget that undercounts by
 * that much stops being the floor its callers rely on. Iterating with `for…of` walks code points,
 * so a surrogate pair is one 4-byte character rather than two 3-byte ones.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}

/**
 * A valid MCP server id: lowercase alphanumerics, dashes and underscores. The id becomes part of
 * the tool names the CLI exposes (`mcp__<id>__<tool>`) and, for Codex, a TOML table key — so an
 * id with a dot, a space or a quote in it produces either an unmatchable allow-list entry or a
 * malformed config, both of which fail deep inside the CLI rather than at registration.
 */
export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidMcpServerId(id: string): boolean {
  return MCP_SERVER_ID_PATTERN.test(id)
}

/**
 * A tool name an `allowedTools` entry may name: letters, digits, `_`, `.` and `-` (the character
 * set MCP tool names actually use), and nothing else.
 *
 * The rule exists for the COMMA above all. `claudeAllowedToolPatterns` renders each entry as
 * `mcp__<server>__<tool>` and the harness passes the whole list as ONE `--allowedTools` argument
 * joined by commas, so `search_issues,get_issue` in a single entry becomes two patterns of which
 * the first is `mcp__issues__search_issues` (right, but by accident) and the second a bare
 * `get_issue` that matches no tool the CLI has. Whitespace is refused for the same reason, and the
 * failure mode is the one this whole area exists to prevent: the PROMPT still advertises the name
 * verbatim, so the agent is told about a tool the allow-list never granted.
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_PATTERN.test(name)
}

/**
 * Whether an HTTP tool server's URL may be dispatched. `https` always; plain `http` ONLY for
 * loopback, because an HTTP server routinely carries a resolved credential in a request header
 * and cleartext on any other host puts that credential on the wire. Loopback is exempt so a
 * server running beside the agent in its own container stays usable without a certificate.
 *
 * Deliberately NOT a general SSRF guard: the URL is deployment-authored composition-root data
 * (an operator naming their own service), not user input, and the request is made by the agent
 * CLI inside the run container rather than by the backend.
 */
export function isAllowedMcpHttpUrl(raw: string): boolean {
  const parsed = parseMcpHttpUrl(raw)
  if (!parsed) return false
  return parsed.scheme === 'https' || isLoopbackHost(parsed.host)
}

/**
 * Whether an HTTP tool server's URL names LOOPBACK — a server running beside the agent, inside the
 * run container.
 *
 * Its own exported predicate because "allowed" and "loopback" answer different questions and only
 * one caller wants the second. The OPERABILITY PROBE cannot reach a loopback endpoint meaningfully:
 * the backend's `127.0.0.1` is a different machine from the container's, so a probe would report on
 * whatever happens to listen on the backend's own port, and a SUCCESS there is the more misleading
 * of the two outcomes. So the probe refuses such a server by name rather than attempting it.
 *
 * True for an `https` loopback url too. The scheme is what {@link isAllowedMcpHttpUrl} rules on;
 * where the server LIVES is this question, and a sidecar with a self-signed certificate is no more
 * reachable from the backend than a cleartext one.
 */
export function isLoopbackMcpHttpUrl(raw: string): boolean {
  const parsed = parseMcpHttpUrl(raw)
  return parsed ? isLoopbackHost(parsed.host) : false
}

/**
 * Whether the url carries an ASCII control character or a space ANYWHERE, which is refused rather
 * than canonicalised.
 *
 * The WHATWG parser strips leading and trailing C0-and-space and REMOVES tab, LF and CR from
 * anywhere in the string, so a url carrying one parses to something other than what it reads as.
 * The admitted string is stored and handed VERBATIM to the agent CLI's MCP config, so admitting one
 * url and starting another is the one thing this predicate may not do. They are all typos in
 * deployment-authored config, and a refusal at registration names the problem where a silent
 * rewrite would not.
 */
function hasControlOrSpace(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) <= 0x20) return true
  }
  return false
}

// The WHATWG URL parser is a global in workerd, in Node and in every agent CLI's own runtime, but
// the kernel compiles against the ES2022 lib only (no DOM/WebWorker), so reach it through
// `globalThis` with a minimal local type rather than pulling in the DOM lib: the same trade
// `ports/binary-artifacts.ts` makes for Web Crypto.
interface MinimalUrl {
  readonly protocol: string
  readonly hostname: string
}
const UrlParser = (globalThis as { URL?: new (url: string) => MinimalUrl }).URL

/**
 * Split an http(s) URL into its scheme and bare host, or undefined when it is neither.
 *
 * Parsed by `new URL` DELIBERATELY: it is the same WHATWG parser `fetch` and every agent CLI we
 * hand the url to resolve the request with, so the host ruled on here is the host the credential
 * actually travels to. A hand-written parse cannot hold that property, and the ways it silently
 * loses it are not enumerable. `http://evil.example\@127.0.0.1/t` is the worked example: a
 * backslash terminates the authority for a special scheme, so the WHATWG host is `evil.example`
 * while an authority regex that stops only at `/?#` reads the userinfo rule onto `127.0.0.1` and
 * hands `evil.example` a cleartext credential header.
 *
 * `hostname` already applies every rule the hand-parse was written for and several it was not:
 * userinfo stripped from the LAST `@`, the host lowercased, IDNA applied, and the IPv4 shorthands
 * (`127.1`, `0177.0.0.1`, `2130706433`) collapsed to the address they dial. Only the brackets an
 * IPv6 literal keeps have to come off, since {@link isLoopbackHost} tests the address itself.
 */
function parseMcpHttpUrl(raw: string): { scheme: string; host: string } | undefined {
  if (hasControlOrSpace(raw)) return undefined
  // A runtime with no URL parser REFUSES rather than falling back to an authority scan. Being
  // unable to hold the property above is exactly what disqualified the hand-written parse, so a
  // fallback would reinstate the bug on the one runtime nobody tests.
  if (!UrlParser) return undefined
  let parsed: MinimalUrl
  try {
    parsed = new UrlParser(raw)
  } catch {
    // silent-catch-ok: an unparseable url IS the "neither" this returns undefined for, and the
    // caller renders the refusal. There is nothing here a cause would add.
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const hostname = parsed.hostname
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return { scheme: parsed.protocol.slice(0, -1), host }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}
