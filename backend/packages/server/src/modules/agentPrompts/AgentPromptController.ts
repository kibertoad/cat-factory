import type { AgentPromptDetail, AgentPromptRevision } from '@cat-factory/contracts'
import {
  getAgentPromptContract,
  listAgentPromptsContract,
  saveAgentPromptContract,
} from '@cat-factory/contracts'
import type { AgentPromptsModule } from '@cat-factory/orchestration'
import { promptIdForKind, promptVersionLabel } from '@cat-factory/agents'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { builtInBaseSystemPrompt, builtInDirectivesFor } from '../../agents/promptOverrides.js'

/** Resolve the agent-prompt module, or refuse with a 503 naming what isn't wired. */
function requireAgentPrompts<E extends AppEnv>(c: Context<E>): AgentPromptsModule {
  return requireCapability(c.get('container').agentPrompts, 'Agent prompts are not configured')
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
  const builtinText = builtInBaseSystemPrompt(agentKind, registry)
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
  app.use('*', requireWorkspacePermission('settings.manage'))

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

  return app
}
