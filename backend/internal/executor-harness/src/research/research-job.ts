import { parseMcpServerSpecs, type McpServerSpec } from '../agent-capabilities.js'
import { parseContextFiles, type ContextFileSpec } from '../context-manifests.js'
import { parseSecretEnvPairs, str, type TestSecretSpec } from '../job-env.js'
import {
  assertAllowedHost,
  parseAgentOutputSpec,
  parseGuardLimits,
  parseHarnessAuth,
  parseReferenceRepos,
  type AgentOutputSpec,
  type AgentResult,
  type GuardLimitsSpec,
  type HarnessAuthFields,
  type ReferenceRepoSpec,
} from '../job.js'
import type { ResearchCredential, ResearchTarget } from './research-tools.logic.js'
import type { CredentialRequest, HttpExchange } from './research-tools-server.js'

/**
 * A research run: an agent over a browser and an HTTP client against a vendor, with NO checkout
 * of its own. Linked services' repos arrive as read-only `referenceRepos`. Its own job kind
 * rather than an `AgentJob` mode, because every `AgentJob` flow is built around a repository it
 * clones and may push to, and this one has neither.
 */
export interface ResearchJob extends HarnessAuthFields {
  jobId: string
  workspaceId?: string
  executionId?: string
  model: string
  systemPrompt: string
  userPrompt: string
  output?: AgentOutputSpec
  /** Read-only clones of the linked services' repos, as siblings in the workspace. */
  referenceRepos?: ReferenceRepoSpec[]
  ghToken?: string
  contextFiles?: ContextFileSpec[]
  guardLimits?: GuardLimitsSpec
  /** The deployment's own tool servers for this run, beside the research tools. */
  mcpServers?: McpServerSpec[]
  /** Capability credentials injected as env, as for any agent job. */
  capabilitySecrets?: TestSecretSpec[]
  research: {
    targets: ResearchTarget[]
    /** Resolved values, held by the research tool server and never shown to the model. */
    credentials: ResearchCredential[]
    /** Whether to start a browser (the `ui` image) for Playwright MCP and `fill_secret`. */
    browser: boolean
  }
}

/** A research run's result: the agent's structured findings, plus what the tools recorded. */
export interface ResearchResult extends AgentResult {
  /** The credential the agent asked a person for, when it stopped to wait for one. */
  needsCredential?: CredentialRequest
  /** The scrubbed HTTP exchanges `http_request` recorded, by the ref the agent cites. */
  httpExchanges?: Array<{ ref: string; exchange: HttpExchange }>
}

const CREDENTIAL_KINDS = new Set(['login', 'api-token', 'oauth-client', 'secret'])

function parseResearchSection(value: unknown): ResearchJob['research'] {
  if (!value || typeof value !== 'object') {
    throw new Error("Invalid research job: 'research' must be an object")
  }
  const o = value as Record<string, unknown>
  const targets = (Array.isArray(o.targets) ? o.targets : []).map((raw, i): ResearchTarget => {
    const t = (raw ?? {}) as Record<string, unknown>
    const baseUrl = str(t.baseUrl, `research.targets[${i}].baseUrl`)
    if (!baseUrl.startsWith('https://')) {
      throw new Error(`Invalid research job: research.targets[${i}].baseUrl must be https`)
    }
    if (t.surface !== 'ui' && t.surface !== 'api') {
      throw new Error(`Invalid research job: research.targets[${i}].surface must be ui or api`)
    }
    return { baseUrl, surface: t.surface }
  })
  if (targets.length === 0) throw new Error('Invalid research job: research.targets is empty')
  const credentials = (Array.isArray(o.credentials) ? o.credentials : []).map((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>
    if (typeof c.kind !== 'string' || !CREDENTIAL_KINDS.has(c.kind)) {
      throw new Error(`Invalid research job: research.credentials[${i}].kind is unknown`)
    }
    return {
      key: str(c.key, `research.credentials[${i}].key`),
      kind: c.kind as ResearchCredential['kind'],
      value: str(c.value, `research.credentials[${i}].value`),
    }
  })
  return { targets, credentials, browser: o.browser === true }
}

/** Validate and narrow an untrusted body into a {@link ResearchJob}, throwing on bad input. */
export function parseResearchJob(input: unknown): ResearchJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const referenceRepos = parseReferenceRepos(o.referenceRepos)
  for (const [i, ref] of referenceRepos.entries()) {
    assertAllowedHost(ref.repo.cloneUrl, `referenceRepos[${i}].repo.cloneUrl`)
  }
  const output = parseAgentOutputSpec(o.output)
  const guardLimits = parseGuardLimits(o.guardLimits)
  const mcpServers = parseMcpServerSpecs(o.mcpServers)
  const capabilitySecrets = parseSecretEnvPairs(o.capabilitySecrets, 'capabilitySecrets')
  const contextFiles = parseContextFiles(o.contextFiles)
  return {
    jobId: str(o.jobId, 'jobId'),
    model: str(o.model, 'model'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    userPrompt: str(o.userPrompt, 'userPrompt'),
    ...parseHarnessAuth(o),
    ...(typeof o.workspaceId === 'string' ? { workspaceId: o.workspaceId } : {}),
    ...(typeof o.executionId === 'string' ? { executionId: o.executionId } : {}),
    ...(typeof o.ghToken === 'string' && o.ghToken ? { ghToken: o.ghToken } : {}),
    ...(output ? { output } : {}),
    ...(referenceRepos.length ? { referenceRepos } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    ...(guardLimits ? { guardLimits } : {}),
    ...(mcpServers?.length ? { mcpServers } : {}),
    ...(capabilitySecrets.length ? { capabilitySecrets } : {}),
    research: parseResearchSection(o.research),
  }
}
