import type {
  Block,
  BlockRepository,
  OutcomeStoragePolicyRepository,
  ProjectDefinitionRepository,
  ProjectOutcomeRow,
  ProjectRecordRepository,
  ProjectRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for what projects of any kind keep: account-published definitions
// (immutable per version), a project's pin and outcome sequence, outcome revisions (first write
// wins), the outcome-storage policy tiers, and the board delete that reclaims them. Run against
// D1 and Postgres.
//
// Two kinds with unrelated shapes share every table here, a research kind and a `notes` kind
// with no definition, so a store that grows to understand one kind's content fails this suite.

export interface ProjectOutcomePersistenceRepos {
  definitions: ProjectDefinitionRepository
  records: ProjectRecordRepository
  policies: OutcomeStoragePolicyRepository
  /** The board a project is homed on, whose delete reclaims the project's records. */
  board: {
    workspaces: WorkspaceRepository
    blocks: BlockRepository
    projects: ProjectRepository
  }
}

function researchDefinition(version: number, question = 'Which auth scheme?') {
  return {
    kind: 'research',
    key: 'acme:vendor',
    version,
    title: 'Vendor',
    credentials: [],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' as const }],
    inputs: [],
    promptAdditions: {},
    spec: {
      brief: 'Learn the vendor.',
      topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question }] }],
    },
  }
}

function notesDefinition(version: number) {
  return {
    kind: 'notes',
    key: 'acme:vendor',
    version,
    title: 'Notes',
    credentials: [],
    targets: [],
    inputs: [],
    promptAdditions: {},
    spec: { heading: 'Decisions' },
  }
}

export function defineProjectOutcomePersistenceSuite(
  name: string,
  makeRepos: () => ProjectOutcomePersistenceRepos,
): void {
  let counter = 0
  const unique = (prefix: string) => {
    counter += 1
    return `${name}-${prefix}-${counter}-${Math.floor(Math.random() * 1e9)}`
  }

  function outcome(
    projectId: string,
    id: string,
    seq: number,
    body: unknown,
    over: Partial<ProjectOutcomeRow> = {},
  ): ProjectOutcomeRow {
    return {
      id,
      projectId,
      stream: 'main',
      seq,
      intent: 'initial',
      schemaVersion: 1,
      taskId: `task-${id}`,
      definitionKey: 'acme:vendor',
      definitionVersion: 1,
      artifactRefs: [],
      createdAt: seq,
      body: { kind: 'inline', json: JSON.stringify(body) },
      bodyBytes: 10,
      ...over,
    }
  }

  async function pinnedProject(repos: ProjectOutcomePersistenceRepos) {
    const projectId = unique('prj')
    await repos.records.insertPin({
      projectId,
      definitionKey: 'acme:vendor',
      definitionVersion: 1,
      definitionHash: 'hash',
      inputs: { vendor: 'Example' },
    })
    return projectId
  }

  const inlineJson = (row: ProjectOutcomeRow | null) =>
    row?.body.kind === 'inline' ? (JSON.parse(row.body.json) as unknown) : undefined

  describe(`[${name}] project outcome persistence`, () => {
    it('publishes a definition version once, isolated per account and per kind', async () => {
      const repos = makeRepos()
      const account = unique('acc')
      const stored = {
        accountId: account,
        definition: researchDefinition(1),
        contentHash: 'h1',
        createdAt: 1,
      }
      expect(await repos.definitions.insert(stored)).toBe(true)
      // A version names one definition forever: a second publish writes nothing.
      expect(
        await repos.definitions.insert({
          ...stored,
          definition: researchDefinition(1, 'Changed?'),
        }),
      ).toBe(false)
      expect(
        (await repos.definitions.get(account, 'research', 'acme:vendor', 1))?.definition,
      ).toEqual(researchDefinition(1))
      await repos.definitions.insert({
        ...stored,
        definition: researchDefinition(2),
        contentHash: 'h2',
      })
      // The same key and version under another kind is another definition.
      expect(
        await repos.definitions.insert({
          ...stored,
          definition: notesDefinition(1),
          contentHash: 'n1',
        }),
      ).toBe(true)
      expect(
        (await repos.definitions.listByAccount(account, 'research')).map(
          (d) => d.definition.version,
        ),
      ).toEqual([1, 2])
      expect(
        (await repos.definitions.listByAccount(account, 'notes')).map((d) => d.definition.spec),
      ).toEqual([{ heading: 'Decisions' }])
      expect(await repos.definitions.listByAccount(unique('other'), 'research')).toEqual([])
    })

    it('pins a project and hands out its outcome sequence atomically', async () => {
      const repos = makeRepos()
      const projectId = await pinnedProject(repos)
      expect(await repos.records.getPin(projectId)).toMatchObject({
        definitionKey: 'acme:vendor',
        inputs: { vendor: 'Example' },
      })
      const taken = await Promise.all(
        [1, 2, 3, 4, 5].map(() => repos.records.reserveSeq(projectId)),
      )
      expect([...taken].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    })

    it('sequences a project with no pin, since not every kind has a definition', async () => {
      const repos = makeRepos()
      const projectId = unique('prj')
      expect(await repos.records.getPin(projectId)).toBeNull()
      expect(await repos.records.reserveSeq(projectId)).toBe(1)
      expect(await repos.records.reserveSeq(projectId)).toBe(2)
    })

    it('keeps the first write of an outcome and lists outcomes in sequence order', async () => {
      const repos = makeRepos()
      const projectId = await pinnedProject(repos)
      expect(
        await repos.records.insertOutcome(outcome(projectId, unique('out'), 2, { a: 'later' })),
      ).toBe(true)
      const firstId = unique('out')
      expect(
        await repos.records.insertOutcome(outcome(projectId, firstId, 1, { a: 'first' })),
      ).toBe(true)
      // A replayed write is ignored rather than recomputed.
      expect(
        await repos.records.insertOutcome(outcome(projectId, firstId, 1, { a: 'replayed' })),
      ).toBe(false)
      expect((await repos.records.listOutcomes(projectId)).map((r) => r.seq)).toEqual([1, 2])
      expect(inlineJson(await repos.records.getOutcome(projectId, firstId))).toEqual({ a: 'first' })
      // Two outcomes can never claim one sequence number, whatever their stream.
      await expect(
        repos.records.insertOutcome(
          outcome(projectId, unique('out'), 1, {}, { stream: 'open-questions' }),
        ),
      ).rejects.toThrow()
    })

    it('round-trips every envelope field, opaque bodies of any shape and the nullable ones', async () => {
      const repos = makeRepos()
      const projectId = unique('prj')
      const id = unique('out')
      const row = outcome(
        projectId,
        id,
        1,
        { heading: 'Decisions', entries: [{ text: 'Use webhooks' }] },
        {
          stream: 'decisions',
          intent: 'edit',
          schemaVersion: 3,
          taskId: null,
          definitionKey: null,
          definitionVersion: null,
          artifactRefs: ['art_a', 'art_b'],
        },
      )
      await repos.records.insertOutcome(row)
      expect(await repos.records.getOutcome(projectId, id)).toEqual(row)
    })

    it('filters outcomes by stream', async () => {
      const repos = makeRepos()
      const projectId = await pinnedProject(repos)
      await repos.records.insertOutcome(outcome(projectId, unique('out'), 1, {}))
      await repos.records.insertOutcome(
        outcome(projectId, unique('out'), 2, {}, { stream: 'open-questions' }),
      )
      await repos.records.insertOutcome(outcome(projectId, unique('out'), 3, {}))
      expect((await repos.records.listOutcomes(projectId, 'main')).map((r) => r.seq)).toEqual([
        1, 3,
      ])
      expect(
        (await repos.records.listOutcomes(projectId, 'open-questions')).map((r) => r.seq),
      ).toEqual([2])
      expect(await repos.records.listOutcomes(projectId, 'absent')).toEqual([])
    })

    it('round-trips an offloaded body reference', async () => {
      const repos = makeRepos()
      const projectId = await pinnedProject(repos)
      const id = unique('out')
      await repos.records.insertOutcome(
        outcome(
          projectId,
          id,
          1,
          {},
          {
            body: { kind: 'offloaded', artifactId: 'art_1' },
            bodyBytes: 3_000_000,
          },
        ),
      )
      expect(await repos.records.getOutcome(projectId, id)).toMatchObject({
        body: { kind: 'offloaded', artifactId: 'art_1' },
        bodyBytes: 3_000_000,
      })
      expect(await repos.records.getOutcome(unique('other'), id)).toBeNull()
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

    it('reclaims every record of a deleted project and nothing of another', async () => {
      const repos = makeRepos()
      const projectId = await pinnedProject(repos)
      const survivor = await pinnedProject(repos)
      await repos.records.reserveSeq(projectId)
      await repos.records.insertOutcome(outcome(projectId, unique('out'), 1, {}))
      await repos.records.insertOutcome(outcome(survivor, unique('out'), 1, {}))
      await repos.policies.set('project', projectId, { offload: 'disabled' })
      await repos.records.deleteByProjects([projectId])
      expect(await repos.records.getPin(projectId)).toBeNull()
      expect(await repos.records.listOutcomes(projectId)).toEqual([])
      expect(await repos.policies.get('project', projectId)).toBeNull()
      // The sequence restarts, so no stale counter survives the project.
      expect(await repos.records.reserveSeq(projectId)).toBe(1)
      expect(await repos.records.listOutcomes(survivor)).toHaveLength(1)
      await repos.records.deleteByProjects([])
    })

    it("reclaims a homed project's records and the board's own tier with the board", async () => {
      const repos = makeRepos()
      const workspaceId = unique('ws')
      const survivor = unique('ws')
      for (const id of [workspaceId, survivor]) {
        await repos.board.workspaces.create(
          { id, name: id, description: null, createdAt: 0, accountId: null },
          null,
          null,
        )
      }
      const rootBlockId = unique('blk')
      const root: Block = {
        id: rootBlockId,
        title: 'Vendor research',
        type: 'project',
        description: '',
        position: { x: 0, y: 0 },
        status: 'ready',
        progress: 0,
        dependsOn: [],
        executionId: null,
        level: 'project',
        parentId: null,
      }
      const projectId = await pinnedProject(repos)
      await repos.board.blocks.insert(workspaceId, root, projectId)
      await repos.board.projects.insert({
        id: projectId,
        accountId: null,
        kind: 'research',
        rootBlockId,
        serviceIds: [],
        createdAt: 0,
      })
      await repos.records.reserveSeq(projectId)
      await repos.records.insertOutcome(outcome(projectId, unique('out'), 1, {}))
      await repos.policies.set('project', projectId, { offload: 'disabled' })
      await repos.policies.set('workspace', workspaceId, { inlineMaxBytes: 1000 })
      await repos.policies.set('workspace', survivor, { inlineMaxBytes: 2000 })

      await repos.board.workspaces.delete(workspaceId)

      expect(await repos.board.projects.get(projectId)).toBeNull()
      expect(await repos.records.getPin(projectId)).toBeNull()
      expect(await repos.records.listOutcomes(projectId)).toEqual([])
      expect(await repos.records.reserveSeq(projectId)).toBe(1)
      expect(await repos.policies.get('project', projectId)).toBeNull()
      expect(await repos.policies.get('workspace', workspaceId)).toBeNull()
      // Another board's tier is not this board's to reclaim.
      expect(await repos.policies.get('workspace', survivor)).toEqual({ inlineMaxBytes: 2000 })
    })
  })
}
