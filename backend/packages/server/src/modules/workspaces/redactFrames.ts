import type { Block, ExecutionInstance, Service } from '@cat-factory/contracts'
import type { GitHubRepo, UserRepoAccessRepository } from '@cat-factory/kernel'

// Per-viewer redaction of service frames backed by a repo the viewer cannot reach.
//
// A repo linked via a member's personal access token (`GitHubRepo.linkedVia === 'user_pat'`)
// is NOT reachable through the workspace's shared GitHub App, so only members whose OWN PAT
// can reach it may see the service's contents. We resolve which of the board's frames are such
// personal repos and whether the viewer has recorded access, then scrub the inaccessible ones:
// the frame keeps only its internal id (so it still renders as a locked node) and its whole
// subtree is dropped from the snapshot. Fail closed — a member we have not positively recorded
// as having access sees "Permission denied", which self-heals once they connect their PAT.

/** The board rows the redaction reasons over (loosely typed — the controller assembles them). */
export interface RedactableBoard {
  blocks: Block[]
  executions: ExecutionInstance[]
  /** The org service catalog (frameBlockId → repoGithubId), when GitHub sharing is wired. */
  services?: Service[]
  /** Bootstrap jobs keyed by their frame block id, when the bootstrap module is wired. */
  bootstrapJobs?: { blockId: string | null }[]
  /** Open notifications keyed by a block id, when the notifications module is wired. */
  notifications?: { blockId: string | null }[]
}

/**
 * Resolve which of the board's service frames are backed by a personal-PAT repo the viewer
 * cannot reach. `services` maps each frame to its repo; `repos` carries each repo's `linkedVia`;
 * `userRepoAccess` is the viewer's recorded PAT-reachable set. Returns the set of frame block
 * ids to redact (empty when nothing is personal, no viewer, or access isn't wired).
 */
export async function resolveDeniedFrameIds(input: {
  viewerUserId: string | undefined
  services: Service[]
  repos: GitHubRepo[]
  userRepoAccess: UserRepoAccessRepository | undefined
}): Promise<Set<string>> {
  const { viewerUserId, services, repos, userRepoAccess } = input
  const denied = new Set<string>()
  if (!userRepoAccess) return denied
  const linkedViaById = new Map(repos.map((r) => [r.githubId, r.linkedVia ?? 'app']))
  // Frames whose backing repo is personal (user_pat). Keyed by frame block id → repo github id.
  const personalFrames: { frameBlockId: string; repoGithubId: number }[] = []
  for (const s of services) {
    if (s.repoGithubId == null) continue
    if (linkedViaById.get(s.repoGithubId) === 'user_pat') {
      personalFrames.push({ frameBlockId: s.frameBlockId, repoGithubId: s.repoGithubId })
    }
  }
  if (personalFrames.length === 0) return denied
  // With no signed-in user we cannot prove access → redact every personal frame (fail closed).
  if (!viewerUserId) {
    for (const f of personalFrames) denied.add(f.frameBlockId)
    return denied
  }
  const repoIds = [...new Set(personalFrames.map((f) => f.repoGithubId))]
  const accessible = new Set(await userRepoAccess.listAccessibleRepoIds(viewerUserId, repoIds))
  for (const f of personalFrames) {
    if (!accessible.has(f.repoGithubId)) denied.add(f.frameBlockId)
  }
  return denied
}

/** The block ids under (and including) the denied frames — the whole redacted subtree. */
function redactedSubtree(blocks: Block[], deniedFrameIds: Set<string>): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const b of blocks) {
    if (b.parentId) {
      const list = childrenOf.get(b.parentId) ?? []
      list.push(b.id)
      childrenOf.set(b.parentId, list)
    }
  }
  const out = new Set<string>()
  const stack = [...deniedFrameIds]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const child of childrenOf.get(id) ?? []) stack.push(child)
  }
  return out
}

/** Scrub a denied frame down to a locked stub: only its id + layout survive, contents blanked. */
function redactFrame(frame: Block): Block {
  return {
    id: frame.id,
    title: '',
    type: frame.type,
    description: '',
    position: frame.position,
    ...(frame.size ? { size: frame.size } : {}),
    status: frame.status,
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: frame.level,
    parentId: frame.parentId,
    accessDenied: true,
  }
}

/**
 * Apply the redaction to an assembled board: scrub each denied FRAME to a locked stub, drop its
 * descendants and their executions, blank the repo linkage on the denied frames' service-catalog
 * entries, and drop bootstrap jobs / notifications anchored inside a redacted subtree. Returns a
 * shallow-copied board — the inputs are not mutated. A no-op when nothing is denied.
 */
export function redactBoard<B extends RedactableBoard>(board: B, deniedFrameIds: Set<string>): B {
  if (deniedFrameIds.size === 0) return board
  const subtree = redactedSubtree(board.blocks, deniedFrameIds)
  const blocks: Block[] = []
  for (const b of board.blocks) {
    if (deniedFrameIds.has(b.id)) blocks.push(redactFrame(b))
    else if (!subtree.has(b.id)) blocks.push(b)
    // else: a descendant of a denied frame — dropped entirely.
  }
  const executions = board.executions.filter((e) => !subtree.has(e.blockId))
  const services = board.services?.map((s) =>
    deniedFrameIds.has(s.frameBlockId)
      ? { ...s, installationId: null, repoGithubId: null, directory: null }
      : s,
  )
  const bootstrapJobs = board.bootstrapJobs?.filter((j) => !(j.blockId && subtree.has(j.blockId)))
  const notifications = board.notifications?.filter((n) => !(n.blockId && subtree.has(n.blockId)))
  return {
    ...board,
    blocks,
    executions,
    ...(services ? { services } : {}),
    ...(bootstrapJobs ? { bootstrapJobs } : {}),
    ...(notifications ? { notifications } : {}),
  }
}
