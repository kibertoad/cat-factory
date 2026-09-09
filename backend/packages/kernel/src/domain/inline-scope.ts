import type { Block } from './types.js'
import type { ModelScope } from '../ports/model-provider.js'

// The scope half of what the INLINE LLM callers share, the sibling of `inlineBlockModel.ts`'s
// model half. Every inline call answers "whose credentials serve this" with the same fold, and
// the answer decides three separate things: which API-key pool is drawn from, whose local model
// endpoints are visible, and (the one that fails loudly) whether a SUBSCRIPTION harness ref can
// lease an individual-usage credential, which is keyed by run and owner.
//
// It exists as a discriminated SUBJECT rather than a `ModelScope` each caller assembles because
// the old shape made an omission indistinguishable from a decision. A caller that dropped a run id
// it held still resolved a model and still returned an answer; nothing failed, and the only trace
// was the call landing on the routing default instead of the workspace's preset. Naming the kind
// turns "I have nothing to give" into a written claim a reviewer can check against the caller's
// own inputs, which is what `kind: 'workspace'` now costs to write.

/** Resolve the block's run/execution + initiator, or `{}` when it has no active run. */
export type ResolveBlockRunContext = (
  workspaceId: string,
  block: Block,
) => Promise<{ executionId?: string; userId?: string }>

/**
 * What an inline caller HAS, as a closed set of shapes.
 *
 * The order below is the order of decreasing credential reach, and each member is reachable:
 *
 * - `block`: the caller holds a board block whose active run supplies both halves. The engine's
 *   inline producers (reviewers, interviewers, judges, the fork chat, the tester companion).
 * - `run`: the caller holds the run directly rather than through a block. A subject carrying its
 *   own run id (the monorepo adoption advisor), or a grading that names the step it graded.
 * - `user`: no run, but a signed-in person owns the request. The in-app assistant and the other
 *   board-authoring surfaces. An individual-usage credential is leasable here through the USER
 *   activation scope, which is what makes this distinct from `workspace` rather than a politer
 *   spelling of it.
 * - `workspace`: nothing else is available. Legal, and a claim: it says the caller holds no run
 *   and no user, not that it did not look. A document import and a library title generator are
 *   the honest cases.
 */
export type InlineScopeSubject = InlineScopeBase &
  (
    | { kind: 'block'; block: Block }
    | { kind: 'run'; executionId: string; userId?: string }
    | { kind: 'user'; userId: string }
    | { kind: 'workspace' }
  )

/**
 * What every subject carries. `accountId` is optional on all of them for the reason
 * {@link ModelScope} states: a facade resolves the workspace's owning account when it is omitted,
 * so naming it is an optimisation for the callers that already hold it (the public-API surfaces),
 * never a tier that goes missing when they do not.
 */
interface InlineScopeBase {
  workspaceId: string
  accountId?: string
}

/**
 * Build the model scope for an inline call.
 *
 * `resolveRunContext` is read for a `block` subject only, and its absence (tests, or a caller with
 * no execution repository) degrades that subject to workspace-only exactly as it did before. Every
 * other kind carries what it needs, so it cannot be silently weakened by a missing dependency.
 *
 * Fields are OMITTED rather than set to undefined, because `ModelScope`'s readers distinguish an
 * absent tier from a null one: `resolveScopedModelProvider` passes the object straight through to
 * a facade that spreads it into a credential pool query.
 */
export async function resolveInlineScope(
  subject: InlineScopeSubject,
  resolveRunContext?: ResolveBlockRunContext,
): Promise<ModelScope> {
  const base = {
    workspaceId: subject.workspaceId,
    ...(subject.accountId ? { accountId: subject.accountId } : {}),
  }
  switch (subject.kind) {
    case 'block': {
      const run = await resolveRunContext?.(subject.workspaceId, subject.block)
      return {
        ...base,
        ...(run?.executionId ? { executionId: run.executionId } : {}),
        ...(run?.userId ? { userId: run.userId } : {}),
      }
    }
    case 'run':
      return {
        ...base,
        executionId: subject.executionId,
        ...(subject.userId ? { userId: subject.userId } : {}),
      }
    case 'user':
      return { ...base, userId: subject.userId }
    case 'workspace':
      return base
  }
}
