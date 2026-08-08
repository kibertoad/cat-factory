import type { TaskSourceWritebackAdapter, TaskWritebackContext } from '@cat-factory/kernel'
import { LinearGraphqlClient, linearAuthFromCredentials } from '../../shared/linear.client.js'
import {
  LINEAR_COMMENT_CREATE_MUTATION,
  LINEAR_ISSUE_ID_QUERY,
  LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY,
  LINEAR_ISSUE_UPDATE_MUTATION,
  buildLinearCommentVariables,
  buildLinearStateUpdateVariables,
  pickStateIdByType,
  type LinearWorkflowState,
} from '../../tracker/linear.writeback.logic.js'

// The writeback capability of the Linear task source.
//
// Linear identifies an issue by UUID in its mutations while the stored external id is the human
// identifier (`ENG-123`), so every write is a lookup then a mutation. Resolve and claim are both
// transitions to a workflow state of a standard TYPE (`completed` / `started`), because Linear
// has no native close, which is why the resolve lookup also reads the team's states.
//
// The transport is `LinearGraphqlClient`, the same host-pinned, redirect-safe client the
// provider's reads use, rather than a caller-injected `fetch`: the writeback now rides the
// provider, so there is one auth + SSRF policy for everything this source does. Auth resolution
// goes through `linearAuthFromCredentials`, which THROWS on a bag with neither an OAuth token nor
// an API key. That is the honest answer for a workspace whose Linear connection is gone, where the
// writeback this replaced returned quietly and let the question echo record a marker for a
// comment nobody received.

/** Linear's GraphQL writeback adapter, wired on the provider itself. */
export const linearWriteback: TaskSourceWritebackAdapter = {
  // The OAuth token / API key comes from the connection's stored bag (`linearAuthFromCredentials`
  // throws on one carrying neither), so an unreadable connection is fatal to every call here.
  authenticates: 'stored-connection',

  async comment(ctx, externalId, body) {
    const client = clientFor(ctx)
    const lookup = await client.query<{ issue?: { id?: string } }>(LINEAR_ISSUE_ID_QUERY, {
      id: externalId,
    })
    const issueId = requireIssueId(lookup?.issue?.id, externalId)
    await client.query(LINEAR_COMMENT_CREATE_MUTATION, buildLinearCommentVariables(issueId, body))
  },

  async resolve(ctx, externalId) {
    await transition(ctx, externalId, 'completed')
  },

  /** Linear HAS workflow states, so the intake mark is a transition and `mark.label` is unused. */
  async markInProgress(ctx, externalId) {
    await transition(ctx, externalId, 'started')
  },
}

/**
 * Move an issue to the team's workflow state of a standard type. A team whose workflow has no
 * state of that type is a no-op rather than an error (there is nothing to move to), where an
 * unresolvable ISSUE throws: the difference between a workflow that cannot express the step and
 * an issue this connection cannot see.
 */
async function transition(
  ctx: TaskWritebackContext,
  externalId: string,
  stateType: 'completed' | 'started',
): Promise<void> {
  const client = clientFor(ctx)
  const lookup = await client.query<{
    issue?: { id?: string; team?: { states?: { nodes?: LinearWorkflowState[] } } }
  }>(LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY, { id: externalId })
  const issueId = requireIssueId(lookup?.issue?.id, externalId)
  const stateId = pickStateIdByType(lookup?.issue?.team?.states?.nodes ?? [], stateType)
  if (!stateId) return
  await client.query(
    LINEAR_ISSUE_UPDATE_MUTATION,
    buildLinearStateUpdateVariables(issueId, stateId),
  )
}

function clientFor(ctx: TaskWritebackContext): LinearGraphqlClient {
  return new LinearGraphqlClient(linearAuthFromCredentials(ctx.credentials))
}

/**
 * An identifier Linear does not resolve is a throw, not a skip: the caller is recording whether
 * the comment landed, and "no such issue for this connection" is exactly the broken link a
 * silent return would hide.
 */
function requireIssueId(id: string | undefined, externalId: string): string {
  if (!id) throw new Error(`Linear issue ${externalId} is not readable through this connection`)
  return id
}
