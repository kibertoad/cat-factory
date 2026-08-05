import type { AgentPromptDetail, AgentPromptRevision } from '@cat-factory/contracts'
import {
  getAgentPromptContract,
  listAgentPromptsContract,
  promoteAgentPromptContract,
  saveAgentPromptContract,
} from '@cat-factory/contracts'
import type { AgentPromptsModule, SandboxModule } from '@cat-factory/orchestration'
import { promptIdForKind, promptVersionLabel } from '@cat-factory/agents'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { shippedBasePromptFor } from '@cat-factory/agents'
import { builtInDirectivesFor } from '../../agents/promptOverrides.js'

/** Resolve the agent-prompt module, or refuse with a 503 naming what isn't wired. */
function requireAgentPrompts<E extends AppEnv>(c: Context<E>): AgentPromptsModule {
  return requireCapability(c.get('container').agentPrompts, 'Agent prompts are not configured')
}

/**
 * Resolve the sandbox module for the promote route. Its OWN accessor rather than a message
 * borrowed from the prompt module's: a deployment can wire prompt overrides without the sandbox,
 * and an operator told "agent prompts are not configured" would go and check the wrong thing.
 */
function requireSandbox<E extends AppEnv>(c: Context<E>): SandboxModule {
  return requireCapability(c.get('container').sandbox, 'The Sandbox is not configured')
}

/**
 * Compose one kind's editor state. The BUILT-IN text is resolved from the running deployment's
 * agent-kind registry rather than stored, so a workspace that reverted to the built-in tracks
 * the product's prompt as it is bumped, and a kind a deployment registered itself is editable
 * exactly like a shipped one.
 */
function detailFor<E extends AppEnv>(
  c: Context<E>,
  agentKind: string,
  revisions: AgentPromptRevision[],
): AgentPromptDetail {
  const registry = c.get('container').agentKindRegistry
  const builtinText = shippedBasePromptFor(agentKind, registry)
  const head = revisions[0]
  const promptId = promptIdForKind(agentKind)
  return {
    agentKind,
    builtinText,
    // MEASURED from the real composition, never restated — see `builtInDirectivesFor`. This is
    // what lets the editor SHOW the rules an override cannot delete instead of claiming them in
    // copy, and it is why adding a directive needs no change here or in the SPA.
    appendedText: builtInDirectivesFor(agentKind, registry),
    ...(promptId ? { builtinVersionLabel: promptVersionLabel(promptId) } : {}),
    effectiveText: head?.text ?? builtinText,
    customized: head?.text != null,
    revisions,
  }
}

/**
 * A workspace's agent system-prompt overrides — the pipeline builder's prompt editor. Mounted
 * under `/workspaces/:workspaceId`.
 *
 * Writes are gated on `settings.manage` like the model-preset library: the pipeline builder
 * itself is member-tier, but an edited prompt changes how EVERY run in the workspace behaves,
 * which is the same blast radius as the model mapping. Reads pass through the mount, so a
 * member using the builder can still see which steps deviate and read the prompt they will run
 * under.
 */
export function agentPromptController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/agent-prompts'])

  buildHonoRoute(app, listAgentPromptsContract, async (c) => {
    const prompts = requireAgentPrompts(c)
    return c.json(await prompts.service.listSummaries(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getAgentPromptContract, async (c) => {
    const prompts = requireAgentPrompts(c)
    const { agentKind } = c.req.valid('param')
    const revisions = await prompts.service.listRevisions(param(c, 'workspaceId'), agentKind)
    return c.json(detailFor(c, agentKind, revisions), 200)
  })

  buildHonoRoute(app, saveAgentPromptContract, async (c) => {
    const prompts = requireAgentPrompts(c)
    const { agentKind } = c.req.valid('param')
    const revisions = await prompts.service.save(
      param(c, 'workspaceId'),
      agentKind,
      c.req.valid('json'),
      c.get('user')?.id,
    )
    return c.json(detailFor(c, agentKind, revisions), 200)
  })

  buildHonoRoute(app, promoteAgentPromptContract, async (c) => {
    const prompts = requireAgentPrompts(c)
    const sandbox = requireSandbox(c)
    const { agentKind } = c.req.valid('param')
    const workspaceId = param(c, 'workspaceId')
    const { sandboxPromptVersionId } = c.req.valid('json')

    const version = await sandbox.service.getPrompt(workspaceId, sandboxPromptVersionId)
    if (!version) throw new NotFoundError('Sandbox prompt version', sandboxPromptVersionId)
    // The version carries the kind it was written FOR. Promoting it onto a different kind would
    // install e.g. a code-reviewer prompt as the requirements reviewer — a silently wrong run
    // rather than an error — so the mismatch is refused instead of trusted from the path.
    if (version.agentKind !== agentKind) {
      throw new ValidationError('That prompt version belongs to a different agent.', {
        reason: 'agent_kind_mismatch',
        expected: agentKind,
        actual: version.agentKind,
      })
    }
    // An ordinary append: revertible, visible in the history, and a no-op when the promoted text
    // is already live. The TEXT comes from the stored version, never from the request.
    const revisions = await prompts.service.save(
      workspaceId,
      agentKind,
      { text: version.systemText },
      c.get('user')?.id,
    )
    return c.json(detailFor(c, agentKind, revisions), 200)
  })

  return app
}
