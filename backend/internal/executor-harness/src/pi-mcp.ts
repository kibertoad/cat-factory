import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type McpServerSpec, mcpServerSecretValues, piMcpConfig } from './agent-capabilities.js'
import { registerKnownSecrets } from './redact.js'

// Wires a run's tool servers (MCP) into Pi, whose built-in MCP client (0.99.0 onward) reads the
// `mcp.json` in its config directory. The document is composed by `piMcpConfig`; this module owns
// only where it goes.

/**
 * Write Pi's `mcp.json` into this pass's own config directory (`createPiAgentDir`), or nothing when
 * the pass wires no server.
 *
 * The file carries the resolved credentials, the same as the claude-code and codex per-run configs
 * do, and for the same reason: a value written into the file reaches only the server it is
 * declared on. Routing a value through Pi's environment instead would hand it to every process Pi
 * starts, since Pi spawns a stdio server with its own whole environment plus the declared one: the
 * agent's shell, every repo script it runs, and every OTHER server. The directory is fresh and
 * owner-only for each pass and removed after it, so the file needs no clearing and no mode repair.
 *
 * The credential values are registered for redaction here, the same as the claude-code and codex
 * homes do: a stdio server that fails to start echoes its own environment into stderr often
 * enough, and that tail reaches the step's diagnostics.
 */
export async function writePiMcpConfig(
  agentDir: string,
  servers: readonly McpServerSpec[] | undefined,
): Promise<void> {
  if (!servers?.length) return
  registerKnownSecrets(mcpServerSecretValues(servers))
  await writeFile(
    join(agentDir, 'mcp.json'),
    `${JSON.stringify(piMcpConfig(servers), null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  )
}
