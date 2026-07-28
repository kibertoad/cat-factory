import type { McpSecretRef } from '../domain/agent-capabilities.js'

/**
 * Resolves the credentials a tool server (MCP) declared, per dispatch. The port exists so the
 * SECRET half of a tool server is a deployment concern the facade owns, while the server
 * DEFINITION stays static composition-root data on the agent-kind registry.
 *
 * Both facades wire the deployment-environment resolver by default (`createEnvToolSecretResolver`
 * in `@cat-factory/server`), which reads each declared key off the deployment's own configured
 * environment — so a tool server works with no new storage, no table and no UI. A deployment that
 * needs PER-WORKSPACE credentials implements this port instead (reading its own sealed store);
 * nothing else in the dispatch path changes.
 *
 * Contract: it is called ONCE per dispatch per server, must never throw (an unresolvable key is
 * simply absent from the returned record — the caller decides whether that drops the server), and
 * the values it returns are written STRAIGHT into the job body's dedicated `mcpServers` field.
 * They never touch `AgentRunContext`, a prompt, or the telemetry snapshot.
 */
export interface ToolSecretResolver {
  resolve(input: {
    workspaceId: string
    /** The block the run is for, so a per-service credential store can scope its lookup. */
    blockId?: string
    /** The tool server's id, as registered. */
    serverId: string
    /** The secrets the server declared. */
    keys: McpSecretRef[]
  }): Promise<Record<string, string>>
}
