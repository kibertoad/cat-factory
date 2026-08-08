import type { AgentRunContext, Block } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The `block` sub-payload of an agent run context: the block's identity plus the many OPTIONAL
// fields a dispatch may carry (resolved fragments, technical label, model preset, PR + peer PRs,
// linked context docs/tasks, estimate, per-type creation fields, doc-authoring template /
// exemplars / brief).
//
// Its own module rather than a method on the builder because it reads nothing off the builder: it
// is a pure projection of what the resolution wave already produced, and keeping it here is what
// leaves the builder itself under its size budget as the context grows new fields.
// ---------------------------------------------------------------------------

/** The sub-payload this module builds. */
type BlockPayload = AgentRunContext['block']

/** What the resolution wave hands the projection below. */
export interface BlockPayloadArgs {
  block: Block
  description: string
  /** The fold's resolved fragment bodies, or null/undefined when nothing was folded. */
  resolved: { fragments: NonNullable<BlockPayload['resolvedFragments']> } | null | undefined
  agentConfig: Block['agentConfig']
  /**
   * The resolved linked documents, each still carrying the SOURCE identity the dispatch record
   * keys on. It is dropped below: an agent reads a page, not an id.
   */
  contextDocs: (NonNullable<BlockPayload['contextDocs']>[number] & { externalId: string })[]
  contextTasks: NonNullable<BlockPayload['contextTasks']>
  docAuthoring: Pick<BlockPayload, 'docTemplateBody' | 'docExemplars' | 'docInterviewBrief'>
}

/**
 * Assemble the `block` sub-payload of the agent context — the block identity plus its many
 * OPTIONAL fields (resolved fragments, technical label, model preset, PR + peer PRs, linked
 * context docs/tasks, estimate, per-type creation fields, doc-authoring template/exemplars/
 * brief). Its arguments are stated structurally rather than as the builder's own private return
 * types: what this projects is the CONTEXT's shape, so a resolver that grows a field has to decide
 * it into or out of the payload here rather than have it appear by inference.
 */
export function buildBlockPayload(args: BlockPayloadArgs): BlockPayload {
  const { block, description, resolved, agentConfig, contextDocs, contextTasks, docAuthoring } =
    args
  return {
    id: block.id,
    title: block.title,
    type: block.type,
    description,
    fragmentIds: block.fragmentIds,
    ...(resolved ? { resolvedFragments: resolved.fragments } : {}),
    // The resolved technical label, threaded whenever a concrete determination exists
    // (true ⇒ task definition is primary + spec-writer may skip specs; false ⇒ explicit
    // business, spec-writer must produce specs). Omitted only when unset, so an
    // undetermined task keeps the unchanged spec-led behaviour.
    ...(typeof block.technical === 'boolean' ? { technical: block.technical } : {}),
    modelId: block.modelId,
    ...(block.modelPresetId ? { modelPresetId: block.modelPresetId } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(block.pullRequest ? { pullRequest: block.pullRequest } : {}),
    // Peer PRs from a multi-repo run (own-service PR stays on `pullRequest`) — the merger
    // reads these to clone each peer's PR branch and score the combined cross-repo diff.
    ...(block.peerPullRequests?.length ? { peerPullRequests: block.peerPullRequests } : {}),
    // The source id each resolved doc carries is dropped here: it exists so the DISPATCH RECORD
    // can key a document across the steps that read it, and an agent reads a page rather than
    // an id. Projected explicitly rather than spread, so a field added to the resolver has to
    // be decided into or out of the container payload.
    ...(contextDocs.length
      ? { contextDocs: contextDocs.map(({ externalId: _externalId, ...doc }) => doc) }
      : {}),
    ...(contextTasks.length ? { contextTasks } : {}),
    // The task-estimator's triage, when produced earlier in this run — the
    // consensus executor's gating input.
    ...(block.estimate ? { estimate: block.estimate } : {}),
    // Per-type creation fields (a `document` task's docKind/audience/targetPath/…),
    // so a kind's user-prompt builder can specialise on them — the document-authoring
    // agents read these. Sparse; omitted when none were collected.
    ...(block.taskTypeFields ? { taskTypeFields: block.taskTypeFields } : {}),
    // Workspace-linked template / exemplar documents for a doc-authoring kind (WS1). Omitted
    // when nothing is linked (the prompts then fall back to the built-in skeleton / built-in
    // exemplars) or the kind isn't doc-aware.
    ...(docAuthoring.docTemplateBody ? { docTemplateBody: docAuthoring.docTemplateBody } : {}),
    ...(docAuthoring.docExemplars?.length ? { docExemplars: docAuthoring.docExemplars } : {}),
    // The converged interactive-interview authoring brief (WS5), when the interview ran and
    // synthesized one — the doc-writer folds it in as the refined spec to write from.
    ...(docAuthoring.docInterviewBrief
      ? { docInterviewBrief: docAuthoring.docInterviewBrief }
      : {}),
  }
}
