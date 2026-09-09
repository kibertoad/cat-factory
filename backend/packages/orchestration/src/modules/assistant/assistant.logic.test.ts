import type { Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  assistantActionBriefs,
  issueRepoSlug,
  keepDeclaredArguments,
  matchServiceByName,
  parseRepoRef,
  readAssistantSelection,
  serviceFramesOf,
} from './assistant.logic.js'
import type { AssistantActionDefinition } from './types.js'

// Minimal block factory: only the fields the assistant's resolution reads.
function frame(id: string, title: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

describe('readAssistantSelection', () => {
  it('reads an action and its string arguments', () => {
    expect(
      readAssistantSelection({
        action: 'create-task-from-issue',
        arguments: { issueUrl: ' https://example.test/i/1 ' },
      }),
    ).toEqual({
      kind: 'action',
      actionId: 'create-task-from-issue',
      arguments: { issueUrl: 'https://example.test/i/1' },
    })
  })

  it('reads the declared decline', () => {
    expect(readAssistantSelection({ action: 'none', arguments: {} })).toEqual({ kind: 'none' })
  })

  it('treats a reply that is not an object, or names no action, as unreadable', () => {
    expect(readAssistantSelection(null).kind).toBe('unreadable')
    expect(readAssistantSelection('add a service').kind).toBe('unreadable')
    expect(readAssistantSelection({ arguments: {} }).kind).toBe('unreadable')
    expect(readAssistantSelection({ action: '   ' }).kind).toBe('unreadable')
  })

  it('drops non-string and blank argument values rather than stringifying them', () => {
    // A stringified object would reach a name match as a lookup for something nobody can type;
    // dropped, it reads downstream exactly like the omission it is.
    const selection = readAssistantSelection({
      action: 'declare-service-dependency',
      arguments: { consumer: 'Checkout', provider: { name: 'Payments' }, description: '  ' },
    })
    expect(selection).toEqual({
      kind: 'action',
      actionId: 'declare-service-dependency',
      arguments: { consumer: 'Checkout' },
    })
  })

  it('tolerates a missing or non-object arguments bag', () => {
    expect(readAssistantSelection({ action: 'add-service-from-repo' })).toEqual({
      kind: 'action',
      actionId: 'add-service-from-repo',
      arguments: {},
    })
    expect(readAssistantSelection({ action: 'add-service-from-repo', arguments: [1, 2] })).toEqual({
      kind: 'action',
      actionId: 'add-service-from-repo',
      arguments: {},
    })
  })
})

describe('matchServiceByName', () => {
  const frames = [frame('f1', 'Payments API'), frame('f2', 'Checkout'), frame('f3', 'API Gateway')]

  it('prefers an exact title over a containment hit', () => {
    // `Api Gateway` also contains "api", so a containment-first order would call this ambiguous.
    expect(matchServiceByName([...frames, frame('f4', 'API')], 'api')).toMatchObject({
      kind: 'one',
      frame: { id: 'f4' },
    })
  })

  it('matches across punctuation and case', () => {
    expect(matchServiceByName([frame('f1', 'user-service')], 'User Service')).toMatchObject({
      kind: 'one',
      frame: { id: 'f1' },
    })
  })

  it('falls back to containment for a partial name', () => {
    expect(matchServiceByName(frames, 'checkout')).toMatchObject({
      kind: 'one',
      frame: { id: 'f2' },
    })
    expect(matchServiceByName(frames, 'payments')).toMatchObject({
      kind: 'one',
      frame: { id: 'f1' },
    })
  })

  it('reports every candidate rather than tie-breaking', () => {
    expect(matchServiceByName(frames, 'api')).toEqual({
      kind: 'many',
      candidates: ['Payments API', 'API Gateway'],
    })
  })

  it('reports no match for a name nothing resembles, and for an empty one', () => {
    expect(matchServiceByName(frames, 'billing')).toEqual({ kind: 'none' })
    expect(matchServiceByName(frames, '  ')).toEqual({ kind: 'none' })
  })

  it('a title with nothing to fold matches nothing but itself, and poisons no other name', () => {
    // A non-Latin title folds to the empty string, and `''` is a substring of everything: left
    // unguarded, this one frame matches EVERY name typed on this board. The damage is not that it
    // over-matches itself, it is that every other service on the board stops resolving, because a
    // unique hit becomes a two-way `ambiguous_service` nobody can answer.
    const board = [frame('f1', '決済サービス'), frame('f2', 'Payments API')]
    expect(matchServiceByName(board, 'payments')).toMatchObject({
      kind: 'one',
      frame: { id: 'f2' },
    })
    expect(matchServiceByName(board, 'gateway')).toEqual({ kind: 'none' })
    // Reachable by the pass that needs no fold: its real characters.
    expect(matchServiceByName(board, '決済サービス')).toMatchObject({
      kind: 'one',
      frame: { id: 'f1' },
    })
  })

  it('two unfoldable titles do not become ambiguous with each other', () => {
    const board = [frame('f1', '決済'), frame('f2', '🚀')]
    expect(matchServiceByName(board, 'anything')).toEqual({ kind: 'none' })
  })
})

describe('parseRepoRef', () => {
  it('reads a pasted web URL, on either provider shape', () => {
    expect(parseRepoRef('https://github.com/acme/payments')).toEqual({
      owner: 'acme',
      repo: 'payments',
    })
    expect(parseRepoRef('https://gitlab.com/acme/platform/billing/-/tree/main/svc')).toEqual({
      owner: 'acme/platform',
      repo: 'billing',
      directory: 'svc',
    })
  })

  it('recovers the subtree a URL points into, and refuses an unsafe one rather than passing it on', () => {
    expect(parseRepoRef('https://github.com/acme/mono/tree/main/packages/api')).toEqual({
      owner: 'acme',
      repo: 'mono',
      directory: 'packages/api',
    })
    expect(parseRepoRef('https://github.com/acme/mono/tree/main/../../etc')).toEqual({
      owner: 'acme',
      repo: 'mono',
    })
  })

  it('accepts the bare slug the shared URL parser declines, because a candidate IS one', () => {
    // `nearMisses` offers `owner/name`, so a turn that could not read one back would be asking a
    // question whose own answer it refuses.
    expect(parseRepoRef('acme/payments')).toEqual({ owner: 'acme', repo: 'payments' })
    expect(parseRepoRef('acme/platform/billing.git')).toEqual({
      owner: 'acme/platform',
      repo: 'billing',
    })
  })

  it('refuses prose, a lone name, and anything with a segment that is not one', () => {
    expect(parseRepoRef('the payments repo')).toBeNull()
    expect(parseRepoRef('payments')).toBeNull()
    expect(parseRepoRef('acme/pay ments')).toBeNull()
    expect(parseRepoRef('acme//payments')).toBeNull()
    expect(parseRepoRef('  ')).toBeNull()
  })
})

describe('serviceFramesOf', () => {
  it('keeps only the visible service frames', () => {
    const blocks = [
      frame('f1', 'Payments'),
      frame('f2', 'Docs', { type: 'library' }),
      frame('f3', 'Archived', { archived: true }),
      frame('f4', 'Anchor', { internal: true }),
      frame('t1', 'A task', { level: 'task', parentId: 'f1' }),
    ]
    expect(serviceFramesOf(blocks).map((b) => b.id)).toEqual(['f1'])
  })
})

describe('keepDeclaredArguments', () => {
  const fields = [
    { key: 'consumer', label: 'Consumer', required: true },
    { key: 'provider', label: 'Provider', required: true },
  ]

  it('keeps declared keys and drops the rest', () => {
    // A router that invents a key was told the list and put something else beside it; refusing the
    // whole turn for that would throw away an otherwise correct routing.
    expect(
      keepDeclaredArguments(fields, { consumer: 'A', provider: 'B', urgency: 'high' }),
    ).toEqual({ consumer: 'A', provider: 'B' })
  })
})

describe('assistantActionBriefs', () => {
  const action = {
    actionId: 'declare-service-dependency',
    purpose: 'Record that one service depends on another.',
    examples: ['a depends on b'],
    parameters: [
      { key: 'consumer', label: 'Consumer service', help: 'The one that depends.', required: true },
      { key: 'description', label: 'How it is used' },
    ],
    run: async () => ({
      status: 'needs_input',
      reason: 'missing_argument',
      field: 'consumer',
      candidates: [],
    }),
  } as unknown as AssistantActionDefinition

  it('derives the catalog from the same declaration the validator reads', () => {
    expect(assistantActionBriefs([action])).toEqual([
      {
        actionId: 'declare-service-dependency',
        purpose: 'Record that one service depends on another.',
        examples: ['a depends on b'],
        arguments: [
          { key: 'consumer', description: 'The one that depends.', required: true },
          // No help text: the label stands in rather than an empty description.
          { key: 'description', description: 'How it is used', required: false },
        ],
      },
    ])
  })
})

describe('issueRepoSlug', () => {
  it('reads the repository out of a repo-backed external id', () => {
    expect(issueRepoSlug('acme/payments#12')).toEqual({ owner: 'acme', repo: 'payments' })
  })

  it('keeps a multi-segment GitLab namespace whole', () => {
    expect(issueRepoSlug('group/subgroup/billing#5')).toEqual({
      owner: 'group/subgroup',
      repo: 'billing',
    })
  })

  it('answers null for a tracker key that names no repository', () => {
    // Not a parse failure: Jira and Linear have no repository, so the turn asks which service.
    expect(issueRepoSlug('PROJ-12')).toBeNull()
    expect(issueRepoSlug('ENG-7#3')).toBeNull()
  })
})
