import {
  isReservedPlatformEnvKey,
  projectDefinitionSubjectId,
  type ProjectDefinition,
} from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  CapabilityCredentialMissingError,
  type AgentRunContext,
  type ProjectRunContext,
  type RunnerDispatchKind,
  type ToolSecretResolver,
  type ToolSecretSubject,
} from '@cat-factory/kernel'
import { composeRoleSystemPrompt } from './brief.js'
import { buildRepoSpec } from './containerAgentBody.js'
import { buildDispatchPromptContext } from './dispatchPromptContext.js'
import type { ResolvedToolServers } from './toolServers.js'
import type { MintInstallationToken, RepoTarget, ResolveRepoOrigin } from './repoTargeting.js'
import type { ResolveRepoTargets } from './resolveRepoTarget.js'
import { toolServersSection } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The harness body of a PROJECT job (`kind: 'project'`), the repo-less sibling of `buildJobBody`,
// for a task of any project kind. A project run has no checkout of its own: the project's linked
// services' repos ride as read-only `referenceRepos`, and the pinned definition's credentials are
// resolved here, once, into the `access` section the harness's access tool server holds (the
// values never reach the model). What the agent is asked is the kind's prompt over its brief.
// A credential the definition needs at START that does not resolve
// refuses the dispatch with `CapabilityCredentialMissingError`, so the step parks before any
// container starts. Design: `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

/** What the project body reads, as bound callbacks so the executor stays the only owner. */
export interface ProjectJobBodyDeps {
  agentKindRegistry: AgentKindRegistry
  resolveToolSecrets?: ToolSecretResolver
  resolveRepoTargets?: ResolveRepoTargets
  mintInstallationToken: MintInstallationToken
  resolveRepoOrigin: ResolveRepoOrigin
  /** The executor's model + harness resolution for this dispatch. */
  resolveModel: () => Promise<{ model: string; provider: string }>
  /** The executor's per-job auth (proxy session token or leased subscription token). */
  resolveAuth: () => Promise<{ auth: Record<string, unknown>; subscriptionTokenId?: string }>
  /** The kind's declared tool servers, resolved for this harness. */
  resolveToolServers: (ambientAuth: boolean) => Promise<ResolvedToolServers>
}

export interface ProjectJobBody {
  body: Record<string, unknown>
  model: string
  provider: string
  kind: RunnerDispatchKind
  subscriptionTokenId?: string
  toolServers: ResolvedToolServers
}

/** Assemble the project job body for a `container-project` dispatch. */
export async function buildProjectJobBody(
  context: AgentRunContext,
  ids: { workspaceId: string; executionId: string; jobId: string },
  deps: ProjectJobBodyDeps,
): Promise<ProjectJobBody> {
  const project = requireProject(context)
  // A kind that pins no definition reaches no target and holds no credential.
  const targets = project.definition?.targets ?? []
  const credentials = project.definition
    ? await resolveProjectCredentials(project.definition, {
        workspaceId: ids.workspaceId,
        ...(deps.resolveToolSecrets ? { resolver: deps.resolveToolSecrets } : {}),
      })
    : []
  const [model, authResult, linked] = await Promise.all([
    deps.resolveModel(),
    deps.resolveAuth(),
    resolveLinkedRepos(project, ids.workspaceId, deps),
  ])
  const tools = await deps.resolveToolServers(authResult.auth.ambientAuth === true)
  const ghToken = linked.targets.length
    ? await deps.mintInstallationToken(linked.targets[0]!.installationId, {
        executionId: ids.executionId,
        workspaceId: ids.workspaceId,
        ...(context.initiatedByUserId ? { initiatedBy: context.initiatedByUserId } : {}),
        repoIds: linked.targets.map((t) => t.repoId),
      })
    : undefined
  const promptContext = buildDispatchPromptContext(context, { tools })
  const role = composeRoleSystemPrompt(promptContext, deps.agentKindRegistry)
  const toolSection = toolServersSection(promptContext)
  const userPrompt = deps.agentKindRegistry.userPrompt(promptContext) ?? context.block.description
  const output = deps.agentKindRegistry.agentStep(context.agentKind)?.output
  const body: Record<string, unknown> = {
    jobId: ids.jobId,
    workspaceId: ids.workspaceId,
    executionId: ids.executionId,
    model: model.model,
    ...authResult.auth,
    systemPrompt: toolSection ? `${role}\n\n${toolSection}` : role,
    userPrompt: `${userPrompt}${linked.section ? `\n\n${linked.section}` : ''}`,
    ...(output ? { output } : {}),
    ...(ghToken ? { ghToken } : {}),
    ...(linked.referenceRepos.length ? { referenceRepos: linked.referenceRepos } : {}),
    ...(tools.mcpServers.length ? { mcpServers: tools.mcpServers } : {}),
    access: {
      targets,
      credentials,
      browser: targets.some((t) => t.surface === 'ui'),
    },
  }
  return {
    body,
    model: `${model.provider}:${model.model}`,
    provider: model.provider,
    kind: 'project',
    ...(authResult.subscriptionTokenId
      ? { subscriptionTokenId: authResult.subscriptionTokenId }
      : {}),
    toolServers: tools,
  }
}

function requireProject(context: AgentRunContext): ProjectRunContext {
  if (!context.project) {
    throw new Error(
      `A '${context.agentKind}' step dispatched without its project brief; the project step ` +
        'handler did not run for it.',
    )
  }
  return context.project
}

/**
 * The definition's credentials, resolved for the run's workspace from the credential store
 * (the `project-definition` subject reads no environment). A key in the reserved platform set
 * is never sent. A credential needed at start that does not resolve refuses the dispatch; one the
 * agent asks for later is left out and named in the prompt instead.
 */
export async function resolveProjectCredentials(
  definition: ProjectDefinition,
  args: { workspaceId: string; resolver?: ToolSecretResolver },
): Promise<Array<{ key: string; kind: string; value: string }>> {
  const declared = definition.credentials.filter((c) => !isReservedPlatformEnvKey(c.key))
  if (declared.length === 0) return []
  const subject: ToolSecretSubject = {
    kind: 'project-definition',
    id: projectDefinitionSubjectId(definition.kind, definition.key),
  }
  const values = args.resolver
    ? await args.resolver.resolve({
        workspaceId: args.workspaceId,
        subject,
        keys: declared.map((c) => ({ key: c.key })),
      })
    : {}
  const missing = declared.find((c) => c.requiredAtStart && !values[c.key])
  if (missing) {
    throw new CapabilityCredentialMissingError(`The credential '${missing.key}' is not stored`, {
      key: missing.key,
      declaredBy: subject,
      label: missing.label,
      ...(missing.onboarding ? { onboarding: missing.onboarding } : {}),
      reason: 'The project definition needs this credential before the run can start.',
    })
  }
  return declared
    .filter((c) => values[c.key])
    .map((c) => ({ key: c.key, kind: c.kind, value: values[c.key]! }))
}

/** The linked services' repos as read-only reference clones, plus the prompt line naming them. */
async function resolveLinkedRepos(
  project: ProjectRunContext,
  workspaceId: string,
  deps: Pick<ProjectJobBodyDeps, 'resolveRepoTargets' | 'resolveRepoOrigin'>,
): Promise<{
  targets: RepoTarget[]
  referenceRepos: { repo: Record<string, unknown> }[]
  section: string
}> {
  if (project.linkedFrameBlockIds.length === 0 || !deps.resolveRepoTargets) {
    return { targets: [], referenceRepos: [], section: '' }
  }
  const { checkouts } = await deps.resolveRepoTargets(
    workspaceId,
    null,
    project.linkedFrameBlockIds,
  )
  const targets = checkouts.map((c) => c.target)
  const skipped = project.linkedFrameBlockIds.length - checkouts.flatMap((c) => c.involved).length
  const lines = targets.map((t) => `- \`${t.owner}/${t.name}\` (read-only, never push to it)`)
  if (skipped > 0) {
    lines.push(`- ${skipped} linked service(s) have no repository this workspace can read.`)
  }
  return {
    targets,
    referenceRepos: targets.map((t) => ({ repo: buildRepoSpec(t, deps.resolveRepoOrigin(t)) })),
    section: lines.length ? ['## Linked repositories', ...lines].join('\n') : '',
  }
}
