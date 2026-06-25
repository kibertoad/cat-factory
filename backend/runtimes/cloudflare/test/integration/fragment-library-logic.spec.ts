import type { PromptFragment, PromptFragmentRecord, WorkspaceRepository } from '@cat-factory/kernel'
import {
  FragmentLibraryService,
  fragmentSourceLogic,
  mergeCatalog,
  selectDeterministic,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'

const { parseFragmentMarkdown, slugFromPath, digestListing } = fragmentSourceLogic

function record(over: Partial<PromptFragmentRecord>): PromptFragmentRecord {
  return {
    fragmentId: 'x',
    ownerKind: 'workspace',
    ownerId: 'ws1',
    version: '1.0.0',
    title: 'X',
    category: null,
    summary: 's',
    body: 'b',
    appliesTo: null,
    tags: null,
    sourceId: null,
    sourcePath: null,
    sourceSha: null,
    docSource: null,
    docExternalId: null,
    resolvedAt: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...over,
  }
}

const builtin: PromptFragment = {
  id: 'node.performance',
  version: '1.0.0',
  title: 'Node performance',
  category: 'Node',
  summary: 'perf',
  body: 'builtin body',
}

describe('fragment catalog merge', () => {
  it('overrides built-in by id at the account tier, then the workspace tier', () => {
    const merged = mergeCatalog(
      [builtin],
      [
        record({
          fragmentId: 'node.performance',
          body: 'account body',
          ownerKind: 'account',
          ownerId: 'a1',
        }),
      ],
      [record({ fragmentId: 'node.performance', body: 'workspace body' })],
    )
    const entry = merged.find((e) => e.id === 'node.performance')!
    expect(entry.tier).toBe('workspace')
    expect(entry.body).toBe('workspace body')
  })

  it('lets a tombstone suppress an inherited fragment', () => {
    const merged = mergeCatalog(
      [builtin],
      [],
      [record({ fragmentId: 'node.performance', deletedAt: 5 })],
    )
    expect(merged.map((e) => e.id)).not.toContain('node.performance')
  })

  it('adds new account/workspace fragments alongside built-ins, sorted by id', () => {
    const merged = mergeCatalog(
      [builtin],
      [record({ fragmentId: 'acc.only', ownerKind: 'account', ownerId: 'a1' })],
      [record({ fragmentId: 'ws.only' })],
    )
    expect(merged.map((e) => e.id)).toEqual(['acc.only', 'node.performance', 'ws.only'])
  })
})

describe('deterministic selection', () => {
  it('excludes fragments whose appliesTo gate rejects the block type', () => {
    const ids = selectDeterministic(
      [
        { id: 'fe', title: 'fe', summary: 's', appliesTo: { blockTypes: ['frontend'] } },
        { id: 'be', title: 'be', summary: 's', appliesTo: { blockTypes: ['service'] } },
      ],
      {
        agentKind: 'coder',
        blockType: 'service',
        blockTitle: '',
        blockDescription: '',
        signals: [],
      },
    )
    expect(ids).toEqual(['be'])
  })

  it('excludes fragments whose appliesTo gate rejects the agent kind', () => {
    const ids = selectDeterministic(
      [{ id: 'rev', title: 'r', summary: 's', appliesTo: { agentKinds: ['reviewer'] } }],
      {
        agentKind: 'coder',
        blockType: 'service',
        blockTitle: '',
        blockDescription: '',
        signals: [],
      },
    )
    expect(ids).toEqual([])
  })

  it('prefers tag overlap with the run signals when any candidate is tagged', () => {
    const candidates = [
      { id: 'db', title: 'db', summary: 's', tags: ['db'] },
      { id: 'fe', title: 'fe', summary: 's', tags: ['frontend'] },
      { id: 'general', title: 'g', summary: 's' },
    ]
    const ids = selectDeterministic(candidates, {
      agentKind: 'coder',
      blockType: 'service',
      blockTitle: 'Add a db migration',
      blockDescription: '',
      signals: [],
    })
    expect(ids).toContain('db')
    expect(ids).toContain('general') // untagged stays broadly applicable
    expect(ids).not.toContain('fe')
  })
})

describe('frontmatter parsing', () => {
  it('parses metadata + body, coercing inline arrays and nested appliesTo', () => {
    const parsed = parseFragmentMarkdown(
      'guidelines/backend.md',
      [
        '---',
        'id: backend.errors',
        'title: Backend error handling',
        'summary: Fail fast.',
        'tags: [backend, db]',
        'appliesTo:',
        '  blockTypes: [service, api]',
        '  agentKinds: [reviewer, coder]',
        '---',
        '',
        '- Validate inputs.',
      ].join('\n'),
    )!
    expect(parsed.id).toBe('backend.errors')
    expect(parsed.title).toBe('Backend error handling')
    expect(parsed.tags).toEqual(['backend', 'db'])
    expect(parsed.appliesTo).toEqual({
      blockTypes: ['service', 'api'],
      agentKinds: ['reviewer', 'coder'],
    })
    expect(parsed.body).toContain('Validate inputs')
  })

  it('defaults a missing title/summary leniently from the path and body', () => {
    const parsed = parseFragmentMarkdown('rules/no-secrets.md', 'Never log secrets in production.')!
    expect(parsed.title).toBe('No secrets')
    expect(parsed.summary).toBe('Never log secrets in production.')
  })

  it('slugs paths and digests listings stably (order-independent)', () => {
    expect(slugFromPath('guidelines/Backend Errors.md')).toBe('guidelines-backend-errors')
    const a = digestListing([
      { path: 'a', sha: '1' },
      { path: 'b', sha: '2' },
    ])
    const b = digestListing([
      { path: 'b', sha: '2' },
      { path: 'a', sha: '1' },
    ])
    expect(a).toBe(b)
    expect(a).not.toBe(
      digestListing([
        { path: 'a', sha: '9' },
        { path: 'b', sha: '2' },
      ]),
    )
  })
})

describe('FragmentLibraryService.resolveForRun', () => {
  // An in-memory fragment repo + a stub workspace repo, so resolution is exercised
  // without D1. The default deterministic selector picks the relevant ids.
  function makeService(rows: PromptFragmentRecord[]) {
    const store = new Map(rows.map((r) => [`${r.ownerKind}:${r.ownerId}:${r.fragmentId}`, r]))
    const repo = {
      async listByOwner(ownerKind: string, ownerId: string) {
        return [...store.values()].filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
      },
      async get() {
        return null
      },
      async upsert() {},
      async softDelete() {},
      async listBySource() {
        return []
      },
    }
    const workspaces = {
      async accountOf() {
        return 'acc1'
      },
    } as unknown as WorkspaceRepository
    return new FragmentLibraryService({
      promptFragmentRepository: repo as never,
      workspaceRepository: workspaces,
      clock: { now: () => 0 },
      builtins: [builtin],
    })
  }

  it('unions manual pins with the selector pick, in catalog order, dropping unknown ids', async () => {
    const svc = makeService([
      record({
        fragmentId: 'ws.extra',
        ownerKind: 'workspace',
        ownerId: 'ws1',
        body: 'extra body',
      }),
      record({ fragmentId: 'acc.shared', ownerKind: 'account', ownerId: 'acc1', body: 'acc body' }),
    ])
    const result = await svc.resolveForRun({
      workspaceId: 'ws1',
      agentKind: 'coder',
      blockType: 'service',
      blockTitle: 'login',
      blockDescription: '',
      manualIds: ['node.performance', 'does.not.exist'],
      signals: [],
    })
    // node.performance is a manual pin (kept); the deterministic selector also
    // admits the untagged account/workspace fragments. Unknown id is dropped.
    expect(result.selectedIds).toContain('node.performance')
    expect(result.selectedIds).toContain('ws.extra')
    expect(result.selectedIds).not.toContain('does.not.exist')
    // Bodies travel with the ids for the prompt composer.
    expect(result.fragments.find((f) => f.id === 'ws.extra')?.body).toBe('extra body')
  })
})
