import { defineApiContract } from '@toad-contracts/valibot'
import {
  acknowledgeKaizenEntrySchema,
  listPublicKaizenEntriesQuerySchema,
  publicKaizenEntryListSchema,
  publicKaizenEntrySchema,
} from '../public-kaizen.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public KAIZEN surface: absolute `/api/v1` paths, authenticated
// in-controller by a public-API key. The wire shapes and the reasoning behind them live in
// `../public-kaizen.ts`; the grading machinery behind an entry is `KaizenService`, and the
// surface's own account for an integrator is `backend/docs/public-api.md`.
//
// The scope split follows the one the merge-evidence surface established. Reading gradings is
// `read` like every other read on this API. ACKNOWLEDGING is `write`, not `admin`: it records
// that a person has triaged a recommendation, which starts nothing, spends nothing and merges
// nothing. Requiring `admin` for it would mean an integration whose whole job is draining the
// improvement backlog had to hold a key that also deletes tasks and merges pull requests.
//
// The entries are addressed by ENTRY id under `/api/v1/kaizen/entries`, and both point routes
// re-apply the key's workspace to the row they load, the rule every point read on this API
// follows (`/api/v1/debug/llm-calls/:callId`, `/api/v1/merge-records/:recordId`).
// ---------------------------------------------------------------------------

const entryIdParams = singleStringParam('entryId')

/**
 * One page of the workspace's Kaizen entries, newest first, with the acknowledgement / status /
 * agent-kind / since filters applied in SQL.
 *
 * The read this surface exists for: an improvement loop enumerates every grading the workspace
 * has produced without naming a run or a task first, which is the one thing it cannot know
 * (finding out is the question it is asking). `?acknowledged=false` is the backlog, and paging
 * is keyset, so a poll loop can never skip an entry because a run finished mid-page.
 */
export const listPublicKaizenEntriesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestQuerySchema: listPublicKaizenEntriesQuerySchema,
    pathResolver: () => '/api/v1/kaizen/entries',
    responsesByStatusCode: { 200: publicKaizenEntryListSchema, ...errorResponses },
  }),
)

/**
 * One entry by id: the read-back beside the acknowledge write, so a caller holding an `entryId`
 * (from a page it stored, or from a ticket it filed) can re-read the current grade, its
 * recommendations and its triage state rather than re-paging the list to find it.
 */
export const getPublicKaizenEntryContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: entryIdParams,
    pathResolver: ({ entryId }) => `/api/v1/kaizen/entries/${entryId}`,
    responsesByStatusCode: { 200: publicKaizenEntrySchema, ...errorResponses },
  }),
)

/**
 * Record (or clear) that an entry has been triaged, and answer with the updated entry.
 *
 * `write`, not `admin`: acknowledging is bookkeeping about work a human has already read. The
 * body is optional in practice (an empty `{}` acknowledges), and acknowledging an
 * already-acknowledged entry is a no-op that returns it unchanged, so a retrying client cannot
 * rewrite when the entry was first triaged. An entry the grader has not settled yet is refused
 * `409` with `details.reason: "kaizen_entry_not_settled"`, because there are no recommendations
 * to have triaged.
 */
export const acknowledgePublicKaizenEntryContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: entryIdParams,
    pathResolver: ({ entryId }) => `/api/v1/kaizen/entries/${entryId}/acknowledge`,
    requestBodySchema: acknowledgeKaizenEntrySchema,
    responsesByStatusCode: { 200: publicKaizenEntrySchema, ...errorResponses },
  }),
)
