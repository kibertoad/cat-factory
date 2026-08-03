import type { AgentRunContext } from '@cat-factory/kernel'

/**
 * Render the TOOL SERVERS (MCP) section for a dispatch — the extra tools an agent kind declared
 * and the platform actually wired into this run's CLI, plus the ones it could not.
 *
 * Two halves, both load-bearing:
 *
 * - **Available.** A tool an agent was handed but not told about is a tool it does not use, so
 *   each server carries its registered `guidance` ("what this is for") and, when the definition
 *   restricted them, the exact tool names. The names use the CLI's `mcp__<server>__<tool>`
 *   convention so what the prompt says matches what the agent sees in its tool list.
 * - **Unavailable.** A declared server the running harness cannot serve, or whose credential did
 *   not resolve, is STATED. Silence would leave the agent to discover the gap mid-run — after it
 *   has planned around a tool that was never there — which is exactly the failure the section
 *   exists to prevent.
 *
 * Empty string when the kind declared no tool servers (every built-in run), so the prompt is
 * byte-for-byte unchanged for them.
 */
export function toolServersSection(context: AgentRunContext): string {
  const available = context.toolServers ?? []
  const unavailable = context.unavailableToolServers ?? []
  if (!available.length && !unavailable.length) return ''
  const lines: string[] = ['', '## Tool servers']
  if (available.length) {
    lines.push(
      '',
      'Beyond your built-in tools, these MCP tool servers are connected for this run. Prefer them',
      'over guessing or over shelling out when the job matches what they do:',
    )
    for (const server of available) {
      const where = server.transport === 'stdio' ? 'runs in your sandbox' : 'remote service'
      lines.push(`- **${server.label}** (\`${server.id}\`, ${where})`)
      if (server.guidance) lines.push(`  ${server.guidance}`)
      if (server.tools?.length) {
        lines.push(`  Tools: ${server.tools.map((t) => `\`mcp__${server.id}__${t}\``).join(', ')}`)
      }
    }
  }
  if (unavailable.length) {
    lines.push(
      '',
      'These tool servers are NOT available on this run — do not plan around them, and say so in',
      'your report if their absence changed what you could verify:',
    )
    for (const server of unavailable) {
      lines.push(`- ${server.label} (${UNAVAILABLE_REASONS[server.reason]})`)
    }
  }
  return lines.join('\n')
}

/**
 * Why a declared tool server did not make it into the run, phrased for the AGENT rather than an
 * operator: it needs to know the tool is absent and that trying harder will not produce it, not
 * how the deployment is configured. Keyed off the closed reason union, so a new reason fails the
 * typecheck here rather than rendering as a blank parenthetical.
 */
const UNAVAILABLE_REASONS: Record<
  NonNullable<AgentRunContext['unavailableToolServers']>[number]['reason'],
  string
> = {
  harness_unsupported: 'not supported by the agent runtime this run uses',
  missing_secret: 'its credential is not configured for this deployment',
  // Deliberately the SAME shape of statement as the line above rather than the operator's fault.
  // The agent's disposition is identical (the tool is absent and retrying will not produce it),
  // and telling it that a declaration is misconfigured invites it to work around the platform.
  // The distinction that matters is the operator's, and it is carried by the log line and the
  // boot problem, both of which name the reserved key.
  reserved_secret: 'its credential is not available to this deployment',
}
