import type { Block, Position, SourceTask, TaskContent, TaskSourceKind } from '@cat-factory/kernel'
import { assertFound, ConflictError } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { BoardWritePort } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { TaskImportService } from './TaskImportService.js'
import { toSourceTask } from './TaskImportService.js'

// TaskLinkService: the write side that attaches an imported issue to the board.
// `linkToBlock` records the link so the execution engine feeds the issue to
// agents as extra context; `createTaskFromIssue` goes one step further and
// materialises the issue as a brand-new board task (seeded from the issue), then
// links the issue to it — the inbound analogue of the document integration's
// spawn. Source-agnostic: it works on the projected task records.

export interface TaskLinkServiceDependencies {
  boardService: BoardWritePort
  blockRepository: BlockRepository
  taskRepository: TaskRepository
  /** Imports the epic + child issues (the epic-spawn path needs the detailed content). */
  importService: TaskImportService
}

/** A board task created from an imported issue, plus the now-linked issue. */
export interface TaskFromIssue {
  block: Block
  task: SourceTask
}

/** The result of spawning an epic: the epic node + the child task blocks created. */
export interface SpawnedEpic {
  epic: Block
  tasks: Block[]
}

export class TaskLinkService {
  constructor(private readonly deps: TaskLinkServiceDependencies) {}

  /** Attach an imported issue to a board block as extra agent context. */
  async linkToBlock(
    workspaceId: string,
    blockId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<SourceTask> {
    const block: Block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const task = assertFound(
      await this.deps.taskRepository.get(workspaceId, source, externalId),
      'Task',
      externalId,
    )
    await this.deps.taskRepository.linkBlock(workspaceId, source, externalId, block.id)
    return toSourceTask({ ...task, linkedBlockId: block.id })
  }

  /**
   * Create a new board task from an already-imported issue, inside a container
   * (service frame or module), and link the issue to the new task for context.
   * The title/description are seeded from the issue; the issue stays the source
   * of truth (re-importing refreshes it) and is fed to every agent step via the
   * link. Reuses BoardService.addTask so scope/placement rules stay in one place.
   * `createdBy` (the signed-in user) flows onto the new task for notification routing.
   */
  async createTaskFromIssue(
    workspaceId: string,
    containerId: string,
    source: TaskSourceKind,
    externalId: string,
    createdBy?: string | null,
  ): Promise<TaskFromIssue> {
    const issue = assertFound(
      await this.deps.taskRepository.get(workspaceId, source, externalId),
      'Task',
      externalId,
    )
    // An issue carries a single `linkedBlockId`, so creating a second task from it
    // would silently re-point the link and orphan the first task's issue context.
    // Refuse rather than lose the existing link (the issue is the source of truth).
    if (issue.linkedBlockId) {
      throw new ConflictError(
        `Issue ${externalId} is already linked to task ${issue.linkedBlockId}; unlink it first`,
      )
    }
    // Resolve the container in the REQUEST workspace (like linkToBlock) so the new
    // block and the issue projection share a workspace — the issue link is workspace-
    // scoped, so creating the task in a service mounted from another workspace would
    // leave the link unresolvable at execution time. A foreign/unknown container 404s.
    assertFound(await this.deps.blockRepository.get(workspaceId, containerId), 'Block', containerId)
    const block = await this.deps.boardService.addTask(
      workspaceId,
      containerId,
      {
        title: issueTaskTitle(issue),
        description: issueTaskDescription(issue),
      },
      createdBy ?? null,
    )
    // Link the issue to the new task so agents get the full issue (description,
    // comments, metadata) as context — and the task carries the back-reference.
    await this.deps.taskRepository.linkBlock(workspaceId, source, externalId, block.id)
    return { block, task: toSourceTask({ ...issue, linkedBlockId: block.id }) }
  }

  /**
   * Spawn an epic and its children onto the board. Imports the epic issue, creates an
   * `epic`-level grouping node from it, then imports + materialises each child issue as a
   * board task inside `containerId` (each joined to the epic via `epicId`). Finally it
   * seeds `dependsOn` edges from the issues' normalized links ("blocked by" / "depends on"
   * / "blocks"), resolving link endpoints against the just-created blocks. Edges to issues
   * outside the imported set are skipped, and the board's cycle guard protects against bad
   * data (a rejected edge is ignored, never fatal). The board (`epicId` + `dependsOn`) is
   * the source of truth after the spawn; the issue projections back agent context.
   */
  async spawnEpic(
    workspaceId: string,
    source: TaskSourceKind,
    epicRef: string,
    containerId: string,
    createdBy?: string | null,
    position?: Position,
  ): Promise<SpawnedEpic> {
    // The container must be visible to this workspace (a frame/module the issue tasks land in).
    assertFound(await this.deps.blockRepository.get(workspaceId, containerId), 'Block', containerId)

    const { content: epicContent } = await this.deps.importService.importDetailed(
      workspaceId,
      source,
      epicRef,
    )

    const epic = await this.deps.boardService.addEpic(workspaceId, {
      title: epicTitle(epicContent),
      description: epicDescription(epicContent),
      position: position ?? { x: 40, y: 40 },
    })
    // Link the epic issue to the epic node so its full context is available too.
    await this.deps.taskRepository.linkBlock(workspaceId, source, epicContent.externalId, epic.id)

    // externalId → board block id, for resolving the dependency links afterwards.
    const blockOf = new Map<string, string>([[epicContent.externalId, epic.id]])
    // Every imported issue's content, keyed by external id, so we can read their links.
    const contents = new Map<string, TaskContent>([[epicContent.externalId, epicContent]])
    const tasks: Block[] = []

    for (const childId of epicContent.childExternalIds ?? []) {
      // A child may already be linked elsewhere; skip it rather than re-point its issue link.
      const existing = await this.deps.taskRepository.get(workspaceId, source, childId)
      if (existing?.linkedBlockId) {
        blockOf.set(childId, existing.linkedBlockId)
        continue
      }
      let content: TaskContent
      try {
        content = (await this.deps.importService.importDetailed(workspaceId, source, childId))
          .content
      } catch {
        continue // an unreadable/forbidden child issue is skipped, not fatal
      }
      const block = await this.deps.boardService.addTask(
        workspaceId,
        containerId,
        {
          title: issueTaskTitle(content),
          description: issueTaskDescription(content),
          epicId: epic.id,
        },
        createdBy ?? null,
      )
      await this.deps.taskRepository.linkBlock(workspaceId, source, content.externalId, block.id)
      blockOf.set(content.externalId, block.id)
      contents.set(content.externalId, content)
      tasks.push(block)
    }

    // Collect the dependency edges from the normalized links of every imported issue, keyed
    // by direction so each is unique. A single blocking relationship is represented on BOTH
    // endpoints (Jira surfaces it as the source's outward "blocks" AND the target's inward
    // "is blocked by"; a GitHub body can reference both ways too), and both sides map to the
    // SAME directed edge — so we MUST collapse them to one. `toggleDependency` is a toggle,
    // so seeding the same edge twice would add it then cancel it back out (no edge at all).
    const edges = new Map<string, { target: string; source: string }>()
    for (const [externalId, content] of contents) {
      const here = blockOf.get(externalId)
      if (!here) continue
      for (const link of content.links ?? []) {
        if (link.type === 'relates') continue
        const there = blockOf.get(link.externalId)
        if (!there) continue // a link to an issue we didn't import — skip
        // blockedBy/dependsOn: THIS issue waits on the linked one (this dependsOn linked).
        // blocks: the linked issue waits on this one (linked dependsOn this).
        const [target, source] = link.type === 'blocks' ? [there, here] : [here, there]
        if (target === source) continue
        edges.set(`${target} ${source}`, { target, source })
      }
    }
    for (const { target, source } of edges.values()) {
      // Skip an edge that already exists so a pre-linked child (or a re-spawn) can't toggle
      // an established dependency OFF — `toggleDependency` flips, it doesn't idempotently add.
      const targetBlock = await this.deps.blockRepository.get(workspaceId, target)
      if (targetBlock?.dependsOn.includes(source)) continue
      try {
        await this.deps.boardService.toggleDependency(workspaceId, target, source)
      } catch {
        // Cycle / already-linked / self — ignore; the rest of the graph still lands.
      }
    }

    return { epic, tasks }
  }
}

/** Seed the epic node's title from the epic issue (keyed for traceability). */
function epicTitle(epic: TaskContent): string {
  return `${epic.externalId}: ${epic.title}`
}

/** Seed the epic node's description: a source reference line + the issue body. */
function epicDescription(epic: TaskContent): string {
  const reference = `Imported epic ${epic.url}`
  const body = epic.description.trim()
  return body ? `${reference}\n\n${body}` : reference
}

/** The issue fields the title/description seeders read (satisfied by TaskRecord + TaskContent). */
type IssueSeed = {
  externalId: string
  title: string
  url: string
  description: string
  excerpt?: string
}

/** Seed the new task's title from the issue (keyed for traceability). */
function issueTaskTitle(issue: IssueSeed): string {
  return `${issue.externalId}: ${issue.title}`
}

/** Seed the new task's description: a source reference line + the issue body. */
function issueTaskDescription(issue: IssueSeed): string {
  const reference = `Imported from ${issue.url}`
  const body = issue.description.trim() || (issue.excerpt ?? '').trim()
  return body ? `${reference}\n\n${body}` : reference
}
