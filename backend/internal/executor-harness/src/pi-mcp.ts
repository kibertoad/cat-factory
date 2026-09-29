import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type McpServerSpec, mcpServerSecretValues, piMcpConfig } from './agent-capabilities.js'
import { piAgentDir } from './pi.js'
import { registerKnownSecrets } from './redact.js'

// Wires a run's tool servers (MCP) into Pi, whose built-in MCP client (0.99.0 onward) reads the
// global `mcp.json` in its config directory. The document is composed by `piMcpConfig`; this
// module owns only where it goes and the one lifecycle rule a file there needs.

/**
 * Write (or clear) Pi's `mcp.json` for this pass and return the child env its placeholders
 * resolve from, to be merged into Pi's `extraEnv`.
 *
 * CLEARING is half the contract, not a tidy-up. The file lives in the container's home, and a
 * warm-pool container serves job after job from the same one, so a job with no tool servers that
 * left the previous job's file in place would start that job's servers, with every placeholder
 * resolving to nothing because the env that filled them went with the job that set it. The
 * config is therefore rewritten on every pass, and removed when there is nothing to wire.
 *
 * The credential values are registered for redaction here, the same as the claude-code and codex
 * homes do: a stdio server that fails to start echoes its own environment into stderr often
 * enough, and that tail reaches the step's diagnostics.
 */
export async function writePiMcpConfig(
  servers: readonly McpServerSpec[] | undefined,
): Promise<Record<string, string>> {
  const dir = piAgentDir()
  const path = join(dir, 'mcp.json')
  if (!servers?.length) {
    await rm(path, { force: true })
    return {}
  }
  registerKnownSecrets(mcpServerSecretValues(servers))
  const { document, env } = piMcpConfig(servers)
  await mkdir(dir, { recursive: true })
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return env
}
