import type { McpOAuthConfig, McpSecretRef } from '../domain/agent-capabilities.js'

/**
 * WHAT a credential is being resolved for. A discriminated subject rather than a bare id,
 * because two different registries mint these ids and nothing stops them colliding: a
 * deployment may register a `retro-diffusion` tool server AND a `retro-diffusion` generative
 * integration, and a per-workspace resolver keyed on the id alone would hand each the other's
 * secret. The env-backed default resolver ignores the subject entirely (it looks up the KEY),
 * so the discriminator costs nothing until a deployment scopes by it.
 */
export type ToolSecretSubject =
  /** A tool server (MCP) an agent kind declared — see `McpServerDefinition`. */
  | { kind: 'tool-server'; id: string }
  /**
   * A generative binary integration a STEP selected — see `BinaryGeneratorRegistry`. Its
   * resolved value never reaches a prompt or the telemetry snapshot either; it rides the job
   * body and becomes an environment variable of that one job's agent process.
   */
  | { kind: 'binary-generator'; id: string }
  /**
   * A FOUNDATIONAL SERVICE a dispatch was briefed on — the catalog service a binary-output step
   * stores through, or one whose contracts a consumer kind was handed. Its resolved value rides
   * the job body and becomes an environment variable of that one job's agent process, exactly as
   * the two above do.
   *
   * Only a service the DEPLOYMENT registered in code ever appears here: a stored account or
   * workspace row may not declare a credential, because the shipped resolver reads a declared key
   * off the deployment's own environment.
   */
  | { kind: 'foundational-service'; id: string }

/**
 * Resolves the credentials a declared CAPABILITY needs, per dispatch. The port exists so the
 * SECRET half of a capability is a deployment concern the facade owns, while the DEFINITION
 * stays static composition-root data on an app-owned registry.
 *
 * Both facades wire the deployment-environment resolver by default (`createEnvToolSecretResolver`
 * in `@cat-factory/server`), which reads each declared key off the deployment's own configured
 * environment — so a tool server or a generative integration works with no new storage, no table
 * and no UI. A deployment that needs PER-WORKSPACE credentials implements this port instead
 * (reading its own sealed store) and passes it to its facade's `createToolSecretResolver` option
 * (`startLocal` / `start` / `createWorker`); nothing else in the dispatch path changes, which is
 * the whole reason the resolver is a port rather than an env read at the call site.
 *
 * Contract: it is called ONCE per dispatch per subject, must never throw (an unresolvable key is
 * simply absent from the returned record — the caller decides whether that drops the capability),
 * and the values it returns are written STRAIGHT into a dedicated job-body field. They never touch
 * `AgentRunContext`, a prompt, or the telemetry snapshot.
 *
 * A RESERVED key never reaches an implementation. The two call sites (tool servers, generative
 * integrations) drop a key naming a platform configuration variable BEFORE asking — so the floor
 * holds for a custom resolver too, and an implementation never has to know the rule. See
 * `isReservedPlatformEnvKey` in `@cat-factory/contracts`.
 */
export interface ToolSecretResolver {
  resolve(input: {
    workspaceId: string
    /** The block the run is for, so a per-service credential store can scope its lookup. */
    blockId?: string
    /** What the credentials are for — a tool server, or a generative binary integration. */
    subject: ToolSecretSubject
    /** The secrets the subject declared. */
    keys: McpSecretRef[]
  }): Promise<Record<string, string>>
}

/**
 * What an {@link McpOAuthTokenSource} answered for one dispatch. A DISCRIMINATED result rather
 * than a nullable token, because the three outcomes need three different things said: a working
 * header, "nobody has authorised this board", and "we hold a grant and it did not produce a
 * token". Collapsing the last two into a bare absence is the "absent and zero must never render
 * the same" rule applied to a credential — the first is a person pressing Connect and the second
 * is an outage or a revocation.
 */
export type McpOAuthTokenResult =
  /** A live access token, already folded into the header its declaration named. */
  | { status: 'ok'; header: string; value: string }
  /**
   * `authorization_code` only: this workspace holds no grant for this server. Not an error and
   * not transient — the remedy is the grant flow, and the dispatch states it to the agent as
   * `oauth_not_connected`.
   */
  | { status: 'not_connected' }
  /**
   * A grant (or a client-credentials client) is on file and no access token came out of it: the
   * refresh token was revoked or expired, the authorization server refused or was unreachable, the
   * client secret did not resolve, or discovery failed. `error` is operator-facing prose, already
   * scrubbed at the emit site.
   */
  | { status: 'token_failed'; error: string }

/**
 * Mints the access token a remote (`http`) tool server's OAuth declaration asks for, per dispatch.
 *
 * A PORT rather than a direct call for the same reason {@link ToolSecretResolver} is one: the
 * grant lives in a sealed per-workspace store that only a facade can build (it needs the
 * deployment's `ENCRYPTION_KEY`), while the code that decides what a dispatch carries is
 * runtime-neutral. A facade that wired no store passes nothing, and every OAuth server is then
 * reported to the agent as unavailable rather than dispatched with no `Authorization` header,
 * which would surface as the server 401ing mid-run.
 *
 * Contract: called once per dispatch per server, never throws (a failure is a `token_failed`
 * result), and the value it returns is written STRAIGHT into the job body's `mcpServers` field. It
 * never touches `AgentRunContext`, a prompt, or the telemetry snapshot — the same channel a
 * resolved `secretKeys` value rides, for the same reason.
 *
 * Refreshing is this port's business, not its caller's: the implementation decides whether the
 * stored access token is still usable and exchanges the refresh token when it is not.
 */
export interface McpOAuthTokenSource {
  accessToken(input: {
    workspaceId: string
    /** The tool server's id — the grant is stored per (workspace, server). */
    serverId: string
    /** The remote server's url, which is the default `resource` indicator and discovery root. */
    serverUrl: string
    /** The declaration's OAuth half. */
    oauth: McpOAuthConfig
  }): Promise<McpOAuthTokenResult>
}
