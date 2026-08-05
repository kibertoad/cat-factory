import {
  adoptBugHuntCandidateContract,
  listTrackerBoardsContract,
  runBugHuntContract,
  taskSourceKindSchema,
  type TaskSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { BUGFIX_PIPELINE_ID, ValidationError } from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { runInitiatorRole } from '../../http/runAdmission.js'
import { blockEditActor } from '../../http/workspaceAccess.js'
import { personalGateForBlock, readPersonalPassword } from '../providers/personalCredentialGate.js'
import { requireCapability } from '../../http/guards.js'

// ---------------------------------------------------------------------------
// Bug hunt: pick a connected tracker, pick one of its boards, get its open + unassigned bugs
// ranked by impact against implementation complexity, confirm one, and have it adopted onto
// the board and driven through the bug-fix pipeline. The interactive dual of the recurring
// `bug-intake` step. See `backend/docs/bug-hunt.md`.
//
// Member-tier by design, and deliberately NOT mounted alongside the admin-gated
// `TaskSourceController`: a hunt neither reads nor edits a connection (the service resolves the
// stored credentials itself), and what it actually does — create a task, start a run — is
// exactly the everyday work the member tier exists for. Gating it on `integrations.manage`
// would mean only admins could pick up a bug. The workspace gate's viewer write floor still
// covers the two POSTs.
// ---------------------------------------------------------------------------

/** Resolve the tasks module, or refuse with a 503 naming what isn't wired. */
function requireTasks<E extends AppEnv>(c: Context<E>): TasksModule {
  return requireCapability(c.get('container').tasks, 'Task-source integration is not configured')
}

/**
 * Read + validate the `:source` path param against the source GRAMMAR (a built-in id, or a
 * `<ns>:<name>` id a deployment may have registered). `BugHuntService` resolves the source on the
 * app-owned registry and refuses an unregistered one there, naming the capability it lacks.
 */
function sourceParam<E extends AppEnv>(c: Context<E>): TaskSourceKind {
  const source = param(c, 'source')
  if (!v.is(taskSourceKindSchema, source)) {
    throw new ValidationError(`Malformed task source '${source}'`)
  }
  return source
}

export function bugHuntController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The boards a hunt can be scoped to (Jira projects / Linear teams / GitHub repos). A source
  // whose provider can't enumerate them raises a ValidationError the SPA turns into "type the
  // board in yourself", which is a usable answer; an empty list would not be.
  buildHonoRoute(app, listTrackerBoardsContract, async (c) => {
    const tasks = requireTasks(c)
    const source = sourceParam(c)
    const boards = await tasks.bugHuntService.listBoards(param(c, 'workspaceId'), source)
    return c.json({ source, boards }, 200)
  })

  // Run the hunt. POST because it performs live external calls and carries predicates — the
  // same reasoning as the task-source diagnostics probe. Nothing is written: the response is
  // the ranked board scan, and the user picks from it.
  buildHonoRoute(app, runBugHuntContract, async (c) => {
    const tasks = requireTasks(c)
    const result = await tasks.bugHuntService.hunt(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json'),
    )
    return c.json(result, 200)
  })

  // Adopt the confirmed candidate: import the issue, materialise it as a `bug` task in the
  // chosen container with the issue linked for context, then start the run.
  buildHonoRoute(app, adoptBugHuntCandidateContract, async (c) => {
    const tasks = requireTasks(c)
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const { externalId, containerId, pipelineId: requested } = c.req.valid('json')
    const pipelineId = requested || BUGFIX_PIPELINE_ID

    const { block, task } = await tasks.bugHuntService.adopt({
      workspaceId,
      source: sourceParam(c),
      externalId,
      containerId,
      // Adopting is a member-tier board write, and the start below is an attributed one. Both
      // read the acting tier through their one accessor so the pair cannot disagree (ADR 0037).
      editor: blockEditActor(c),
      createdBy: c.get('user')?.id ?? null,
      pipelineId,
    })
    // Individual-usage models (Claude/GLM/Codex) require the initiator's personal
    // subscription, so the run start goes through the same gate every other start does —
    // resolved AFTER the block exists, since the gate reads the block's resolved models.
    const { initiatedBy, activate } = await personalGateForBlock(
      container,
      workspaceId,
      block.id,
      pipelineId,
      c.get('user'),
      readPersonalPassword(c),
    )
    // A failed start deliberately LEAVES the task on the board. Unlike the public API's
    // anonymous initiative anchor (which rolls back, because nobody would ever find it), this
    // is a task the user explicitly adopted, carrying the issue link and the imported body —
    // deleting it would throw that away and leave them to redo the pick. They can press Run.
    const execution = await container.executionService.start(workspaceId, block.id, pipelineId, {
      initiatedBy,
      // An adopted bug is an ATTRIBUTED start: a person on this board picked this task and
      // pressed the button, so the run is admitted under their tier exactly as a board start is.
      // Omitting it here made the merge preset's `dryRunRoles` a setting a sandboxed member could
      // walk around by adopting a bug instead of starting a task.
      initiatedByRole: runInitiatorRole(c),
      activate,
    })
    return c.json({ block, task, execution }, 201)
  })

  return app
}
