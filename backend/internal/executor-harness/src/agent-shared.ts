import type { AgentJob, AgentResult, McpServerSpec, ImageManifestSpec, SkillSpec } from './job.js'
import type { EffortReport } from './effort.js'

// Small helpers shared by every agent MODE (explore / coding / bootstrap / preview). They live
// apart from `agent.ts` so the bootstrap mode — a whole flow of its own — could move to its own
// module without either file importing the other.

/**
 * Fold an agent's effort self-assessment (lifted from its sentinel file by `runAgentInWorkspace`)
 * onto its final result. Every container mode routes its result through this so the report reaches
 * the backend uniformly. A run that wrote no report passes through unchanged.
 */
export function mergeEffort(
  result: AgentResult,
  effortReport: EffortReport | undefined,
): AgentResult {
  return effortReport ? { ...result, effortReport } : result
}

/**
 * The agent-capability fields (skills, tool servers, reference designs) every agent-running flow
 * forwards to {@link runAgentInWorkspace}. One helper rather than a per-flow spread, so a flow
 * cannot silently be the one that drops a kind's declared playbook, tool server or reference
 * gallery: the failure mode is invisible (the agent simply works without it) and would only show
 * up as degraded output.
 */
export function agentCapabilities(job: AgentJob): {
  skills?: SkillSpec[]
  mcpServers?: McpServerSpec[]
  generateImages?: boolean
  referenceScreenshots?: ImageManifestSpec
  designImages?: ImageManifestSpec
} {
  return {
    ...(job.skills?.length ? { skills: job.skills } : {}),
    ...(job.mcpServers?.length ? { mcpServers: job.mcpServers } : {}),
    ...(job.generateImages ? { generateImages: true } : {}),
    ...(job.referenceScreenshots ? { referenceScreenshots: job.referenceScreenshots } : {}),
    ...(job.designImages ? { designImages: job.designImages } : {}),
  }
}
