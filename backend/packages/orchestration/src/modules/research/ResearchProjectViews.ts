import {
  type AdhocQuestion,
  type FindingsRevision,
  type ResearchCredentialReadiness,
  type ResearchDefinition,
  type ResearchProjectView,
  type ResearchRevisionDetail,
  foldFindings,
  isAdhocQuestionId,
  researchCoverage,
} from '@cat-factory/contracts'
import {
  NotFoundError,
  type ResearchDefinitionSource,
  type ResearchProjectRepository,
  UnavailableError,
  ValidationError,
  type WorkspaceRepository,
} from '@cat-factory/kernel'
import type { MountedProject } from '../projects/ProjectService.js'
import type { ResearchFindingsStore } from './ResearchFindingsStore.js'

export interface ResearchProjectViewsDeps {
  getMounted: (workspaceId: string, projectId: string) => Promise<MountedProject>
  pins: Pick<ResearchProjectRepository, 'get'>
  definitions: ResearchDefinitionSource
  findings: ResearchFindingsStore
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
}

/** Whether each credential a definition declares resolves for the reading board. */
export type CredentialReadinessCheck = (
  definition: ResearchDefinition,
) => Promise<ResearchCredentialReadiness[]>

/**
 * The app's read of one research project mounted on a board: the pin, the definition it names,
 * the current fold and coverage, every revision with where its body lives, and the credential
 * readiness the HTTP layer checks through the same resolver a dispatch reads.
 */
export class ResearchProjectViews {
  constructor(private readonly deps: ResearchProjectViewsDeps) {}

  async read(
    workspaceId: string,
    projectId: string,
    checkCredentials: CredentialReadinessCheck,
  ): Promise<ResearchProjectView> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const pin = await this.requirePin(projectId)
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? ''
    const [resolved, read] = await Promise.all([
      this.deps.definitions.get(accountId, pin.definitionKey, pin.definitionVersion),
      this.deps.findings.readRevisions(project),
    ])
    const readable: FindingsRevision[] = read.flatMap((r) =>
      r.body ? [{ ...r.meta, body: r.body }] : [],
    )
    const folded = foldFindings(readable)
    const adhocQuestions = adhocQuestionsOf(readable)
    const adhocIds = [
      ...new Set([
        ...adhocQuestions.map((q) => q.id),
        ...Object.keys(folded.byQuestion).filter(isAdhocQuestionId),
      ]),
    ]
    const definition = resolved?.definition ?? null
    return {
      projectId,
      pin: {
        definitionKey: pin.definitionKey,
        definitionVersion: pin.definitionVersion,
        definitionHash: pin.definitionHash,
        inputs: pin.inputs,
      },
      definition,
      definitionChanged: resolved !== null && resolved.contentHash !== pin.definitionHash,
      summary: folded.summary,
      latestRevisionId: folded.latestRevisionId,
      findings: Object.values(folded.byQuestion),
      learnings: folded.learnings,
      adhocQuestions,
      coverage: researchCoverage(definition?.topics ?? [], adhocIds, folded),
      revisions: read.map((r) => ({ ...r.meta, storage: r.storage })),
      credentials: definition ? await checkCredentials(definition) : [],
    }
  }

  async revision(
    workspaceId: string,
    projectId: string,
    revisionId: string,
  ): Promise<ResearchRevisionDetail> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const read = await this.deps.findings.readRevision(project, revisionId)
    if (!read) throw new NotFoundError('FindingsRevision', revisionId)
    if (!read.body) {
      throw new UnavailableError(
        'A findings revision body is stored in the blob store, which cannot serve it now',
        'findings_body_unavailable',
        { revisionId },
      )
    }
    return { ...read.meta, storage: read.storage, body: read.body }
  }

  private async requirePin(projectId: string) {
    const pin = await this.deps.pins.get(projectId)
    if (!pin) {
      throw new ValidationError('This project pins no research definition', {
        reason: 'research_project_not_pinned',
        projectId,
      })
    }
    return pin
  }
}

/** The text of every ad-hoc question the revisions answered, the newest wording winning. */
export function adhocQuestionsOf(revisions: readonly FindingsRevision[]): AdhocQuestion[] {
  const byId = new Map<string, AdhocQuestion>()
  for (const revision of [...revisions].sort((a, b) => a.seq - b.seq)) {
    for (const question of revision.body.adhocQuestions) byId.set(question.id, question)
  }
  return [...byId.values()]
}
