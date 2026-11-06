import type { QuestionFinding, ResearchDefinition } from '@cat-factory/contracts'
import type {
  FindingsRevisionRepository,
  FindingsRevisionRow,
  FindingsStoragePolicyRepository,
  ResearchDefinitionRepository,
  ResearchProjectRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for research persistence: account-published definitions (immutable per
// version), what a research project pins and its findings sequence, findings revisions (first
// write wins), and the findings-storage policy tiers. Run against D1 and Postgres.

export interface ResearchPersistenceRepos {
  definitions: ResearchDefinitionRepository
  projects: ResearchProjectRepository
  revisions: FindingsRevisionRepository
  policies: FindingsStoragePolicyRepository
}

function definition(version: number, question = 'Which auth scheme?'): ResearchDefinition {
  return {
    key: 'acme:vendor',
    version,
    title: 'Vendor',
    brief: 'Learn the vendor.',
    topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question }] }],
    credentials: [],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    inputs: [],
    promptAdditions: {},
  }
}

function finding(answer: string): QuestionFinding {
  return {
    questionId: 'scheme',
    status: 'answered',
    answer,
    confidence: 'high',
    evidence: [],
    caveats: [],
  }
}

export function defineResearchPersistenceSuite(
  name: string,
  makeRepos: () => ResearchPersistenceRepos,
): void {
  let seq = 0
  const unique = (prefix: string) => {
    seq += 1
    return `${name}-${prefix}-${seq}-${Math.floor(Math.random() * 1e9)}`
  }

  function revision(projectId: string, id: string, revisionSeq: number, answer: string) {
    return {
      id,
      projectId,
      taskId: `task-${id}`,
      seq: revisionSeq,
      mode: 'initial',
      definitionKey: 'acme:vendor',
      definitionVersion: 1,
      createdAt: revisionSeq,
      body: {
        kind: 'inline',
        json: JSON.stringify({ summary: '', findings: [finding(answer)], learnings: [] }),
      },
      bodyBytes: 10,
    } satisfies FindingsRevisionRow
  }

  async function project(repos: ResearchPersistenceRepos) {
    const projectId = unique('prj')
    await repos.projects.insert({
      projectId,
      definitionKey: 'acme:vendor',
      definitionVersion: 1,
      definitionHash: 'hash',
      inputs: { vendor: 'Example' },
    })
    return projectId
  }

  describe(`[${name}] research persistence`, () => {
    it('publishes a definition version once, isolated per account', async () => {
      const repos = makeRepos()
      const account = unique('acc')
      const stored = {
        accountId: account,
        definition: definition(1),
        contentHash: 'h1',
        createdAt: 1,
      }
      expect(await repos.definitions.insert(stored)).toBe(true)
      // A version names one question list forever: a second publish writes nothing.
      expect(
        await repos.definitions.insert({ ...stored, definition: definition(1, 'Changed?') }),
      ).toBe(false)
      expect(
        (await repos.definitions.get(account, 'acme:vendor', 1))?.definition.topics[0]?.questions[0]
          ?.question,
      ).toBe('Which auth scheme?')
      await repos.definitions.insert({ ...stored, definition: definition(2), contentHash: 'h2' })
      expect(
        (await repos.definitions.listByAccount(account)).map((d) => d.definition.version),
      ).toEqual([1, 2])
      expect(await repos.definitions.listByAccount(unique('other'))).toEqual([])
    })

    it('pins a research project and gives each task one findings sequence number', async () => {
      const repos = makeRepos()
      const projectId = await project(repos)
      expect(await repos.projects.get(projectId)).toMatchObject({
        definitionKey: 'acme:vendor',
        inputs: { vendor: 'Example' },
      })
      const tasks = [1, 2, 3, 4].map(() => unique('task'))
      const taken = await Promise.all(tasks.map((t) => repos.projects.reserveTaskSeq(projectId, t)))
      expect(new Set(taken).size).toBe(tasks.length)
      // A replayed start keeps its place, even when the replays race each other.
      const replayed = await Promise.all(
        [...tasks, ...tasks].map((t) => repos.projects.reserveTaskSeq(projectId, t)),
      )
      expect(replayed).toEqual([...taken, ...taken])
      const late = await repos.projects.reserveTaskSeq(projectId, unique('task'))
      expect(late).toBeGreaterThan(Math.max(...taken))
      await expect(
        repos.projects.reserveTaskSeq(unique('missing'), unique('task')),
      ).rejects.toThrow()
    })

    it('agrees on one sequence number when first claims for a task race', async () => {
      const repos = makeRepos()
      const projectId = await project(repos)
      const task = unique('task')
      const claims = await Promise.all(
        [1, 2, 3, 4, 5].map(() => repos.projects.reserveTaskSeq(projectId, task)),
      )
      expect(new Set(claims).size).toBe(1)
    })

    it('keeps the first write of a revision and lists revisions in sequence order', async () => {
      const repos = makeRepos()
      const projectId = await project(repos)
      expect(await repos.revisions.insert(revision(projectId, unique('rev'), 2, 'later'))).toBe(
        true,
      )
      const firstId = unique('rev')
      expect(await repos.revisions.insert(revision(projectId, firstId, 1, 'first'))).toBe(true)
      // A replayed write is ignored rather than recomputed.
      expect(await repos.revisions.insert(revision(projectId, firstId, 1, 'replayed'))).toBe(false)
      const listed = await repos.revisions.listByProject(projectId)
      expect(listed.map((r) => r.seq)).toEqual([1, 2])
      const first = await repos.revisions.get(projectId, firstId)
      expect(first?.body.kind === 'inline' && JSON.parse(first.body.json).findings[0].answer).toBe(
        'first',
      )
      // Two revisions can never claim one sequence number.
      await expect(
        repos.revisions.insert(revision(projectId, unique('rev'), 1, 'clash')),
      ).rejects.toThrow()
    })

    it('round-trips an offloaded body reference', async () => {
      const repos = makeRepos()
      const projectId = await project(repos)
      const id = unique('rev')
      await repos.revisions.insert({
        ...revision(projectId, id, 1, 'x'),
        body: { kind: 'offloaded', artifactId: 'art_1' },
        bodyBytes: 3_000_000,
      })
      expect(await repos.revisions.get(projectId, id)).toMatchObject({
        body: { kind: 'offloaded', artifactId: 'art_1' },
        bodyBytes: 3_000_000,
      })
      expect(await repos.revisions.get(unique('other'), id)).toBeNull()
    })

    it('sets, reads and clears each policy tier independently', async () => {
      const repos = makeRepos()
      const owner = unique('owner')
      await repos.policies.set('account', owner, { inlineMaxBytes: 1000 })
      await repos.policies.set('workspace', owner, { offload: 'disabled' })
      expect(await repos.policies.get('account', owner)).toEqual({ inlineMaxBytes: 1000 })
      await repos.policies.set('account', owner, { inlineMaxBytes: 2000, offload: 'enabled' })
      expect(await repos.policies.get('account', owner)).toEqual({
        inlineMaxBytes: 2000,
        offload: 'enabled',
      })
      await repos.policies.set('account', owner, null)
      expect(await repos.policies.get('account', owner)).toBeNull()
      expect(await repos.policies.get('workspace', owner)).toEqual({ offload: 'disabled' })
    })

    it('reclaims a deleted project with its revisions and its project-tier policy', async () => {
      const repos = makeRepos()
      const projectId = await project(repos)
      const id = unique('rev')
      await repos.revisions.insert(revision(projectId, id, 1, 'x'))
      await repos.policies.set('project', projectId, { offload: 'disabled' })
      await repos.projects.deleteMany([projectId])
      expect(await repos.projects.get(projectId)).toBeNull()
      expect(await repos.revisions.listByProject(projectId)).toEqual([])
      expect(await repos.policies.get('project', projectId)).toBeNull()
      await repos.projects.deleteMany([])
    })
  })
}
