import type { McpSecretRef } from '../domain/agent-capabilities.js'

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
 * Resolves the credentials a declared CAPABILITY needs, per dispatch. The port exists so the
 * SECRET half of a capability is a deployment concern the facade owns, while the DEFINITION
 * stays static composition-root data on an app-owned registry.
 *
 * Both facades wire the deployment-environment resolver by default (`createEnvToolSecretResolver`
 * in `@cat-factory/server`), which reads each declared key off the deployment's own configured
 * environment — so a tool server or a generative integration works with no new storage, no table
 * and no UI. A deployment that needs PER-WORKSPACE credentials implements this port instead
 * (reading its own sealed store); nothing else in the dispatch path changes.
 *
 * Contract: it is called ONCE per dispatch per subject, must never throw (an unresolvable key is
 * simply absent from the returned record — the caller decides whether that drops the capability),
 * and the values it returns are written STRAIGHT into a dedicated job-body field. They never touch
 * `AgentRunContext`, a prompt, or the telemetry snapshot.
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
