import { getAssistantCapabilityContract, runAssistantTurnContract } from '@cat-factory/contracts'
import type { AssistantModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { blockEditAuthority } from '../../http/workspaceAccess.js'

// ---------------------------------------------------------------------------
// The IN-APP ASSISTANT: one prompt, one action performed on the person's behalf.
// See `backend/docs/in-app-assistant.md`.
//
// Member-tier by design, and for the same reason the bug hunt is: what a turn actually does is
// declare a dependency between two services, put a repository on the board, or file a task from an
// issue: the everyday board authoring the member tier exists for, all of it reachable from a
// button beside the prompt box. Gating the assistant on `integrations.manage` would mean a member
// could do each of those by hand but not ask for them. The workspace gate's viewer write floor
// still covers the POST, and every write the chosen action makes carries the ASKER's own tier
// (`blockEditAuthority`), so the assistant can never be a way around a policy its user is held to.
// ---------------------------------------------------------------------------

/** Resolve the assistant module, or refuse with a 503 naming what isn't wired. */
function requireAssistant<E extends AppEnv>(c: Context<E>): AssistantModule {
  return requireCapability(c.get('container').assistant, 'The assistant is not configured')
}

export function assistantController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // What the assistant can do here, and whether a model is wired to answer at all. Read before the
  // prompt box is offered, so a deployment with no provider says so instead of failing on submit.
  buildHonoRoute(app, getAssistantCapabilityContract, async (c) => {
    return c.json(requireAssistant(c).service.capability(), 200)
  })

  // Run one turn. Errors are NOT caught: a spent budget, an unconfigured integration and an issue
  // already filed as a task are the same refusals the equivalent button raises, and they reach the
  // SPA through the one error funnel with their `details.reason` intact. What a turn answers with
  // instead is the three OUTCOMES, including the questions it needs answered, which are data.
  buildHonoRoute(app, runAssistantTurnContract, async (c) => {
    const assistant = requireAssistant(c)
    const turn = await assistant.service.run({
      workspaceId: param(c, 'workspaceId'),
      prompt: c.req.valid('json').prompt,
      // The asker's own tier, exactly as the inspector's own create/edit forms carry it (ADR 0037).
      editor: blockEditAuthority(c),
      userId: c.get('user')?.id ?? null,
    })
    return c.json(turn, 200)
  })

  return app
}
