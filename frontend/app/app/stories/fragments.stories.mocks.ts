// A small resolved fragment catalog: what `GET /workspaces/:id/prompt-fragments/resolved` returns
// to the picker. Titles, ids and categories follow the built-in collections; bodies are short
// because no panel renders them. Below it, the fragments the library manager curates: a board's
// and an account's own tiers, the repositories they sync from, and the catalog they merge into.
import type { FragmentSource, PromptFragment, ResolvedFragment } from '@cat-factory/contracts'
import type { BlockType } from '~/types/domain'
import { STORY_WORKSPACE_ID } from './api'

function fragment(
  id: string,
  title: string,
  category: string,
  summary: string,
  blockTypes?: BlockType[],
): ResolvedFragment {
  return {
    tier: 'builtin',
    id,
    version: '1.0.0',
    title,
    category,
    summary,
    body: summary,
    ...(blockTypes ? { appliesTo: { blockTypes } } : {}),
  }
}

export const fragmentCatalog: ResolvedFragment[] = [
  fragment(
    'node.performance',
    'Node.js performance',
    'Node',
    'Avoid event-loop blocking, stream large payloads, cache hot paths.',
    ['service', 'api'],
  ),
  fragment(
    'node.best-practices',
    'Node.js best practices',
    'Node',
    'Async/await error handling, config via env, structured logging, graceful shutdown.',
    ['service', 'api'],
  ),
  fragment(
    'react.state',
    'React state management',
    'React',
    'Keep state local, derive instead of syncing, lift only when shared.',
    ['frontend'],
  ),
  fragment(
    'acceptance.scenarios',
    'Acceptance scenarios',
    'Acceptance testing',
    'Write the scenarios before the code, one behaviour each.',
  ),
]

/** A fragment of one owner's own tier, as `listPromptFragmentsContract` lists it. */
export function promptFragment(
  overrides: Partial<PromptFragment> & Pick<PromptFragment, 'id' | 'title' | 'summary'>,
): PromptFragment {
  return {
    version: '1.0.0',
    category: 'Guidelines',
    body: overrides.summary,
    ...overrides,
  }
}

/** The repository a board links its written guidelines from, synced last week. */
export const handbookSource: FragmentSource = {
  id: 'frs_handbook',
  ownerKind: 'workspace',
  ownerId: STORY_WORKSPACE_ID,
  repoOwner: 'acme',
  repoName: 'engineering-handbook',
  gitRef: 'main',
  dirPath: 'guidelines',
  lastSyncedCommit: '9c41e07d2b',
  lastSyncedAt: Date.UTC(2026, 9, 7, 10, 30),
  createdAt: Date.UTC(2026, 8, 14),
}

/** A second repository, linked but not synced yet, read at its default branch. */
export const platformStandardsSource: FragmentSource = {
  ...handbookSource,
  id: 'frs_platform',
  repoName: 'platform',
  gitRef: 'HEAD',
  dirPath: 'docs/standards',
  lastSyncedCommit: null,
  lastSyncedAt: null,
  createdAt: Date.UTC(2026, 9, 13),
}

/**
 * The board's own tier: one fragment written here, one synced from the handbook, and one that
 * follows a Confluence page.
 */
export const workspaceFragments: PromptFragment[] = [
  promptFragment({
    id: 'ws.error-envelope',
    title: 'Auth Service error envelope',
    summary: 'Every error answers { error: { code, message, details } }, with a reason code.',
    tags: ['api', 'errors'],
  }),
  promptFragment({
    id: 'handbook.readme',
    title: 'Service README structure',
    summary: 'Purpose, how to run it, how to test it, who owns it, in that order.',
    source: { sourceId: handbookSource.id, path: 'guidelines/readme.md', sha: 'a1f09c3' },
  }),
  promptFragment({
    id: 'doc.session-lifecycle',
    title: 'Session lifecycle',
    summary: 'How sessions start, refresh and end, and what revokes them.',
    documentRef: { source: 'confluence', externalId: '48213377' },
    resolvedAt: Date.UTC(2026, 9, 13, 8, 0),
  }),
]

/** The account's own tier: two fragments written for every board of the account. */
export const accountFragments: PromptFragment[] = [
  promptFragment({
    id: 'acme.logging',
    title: 'Acme logging conventions',
    summary: 'Structured JSON logs, a request id on every line, no personal data.',
    tags: ['backend'],
  }),
  promptFragment({
    id: 'acme.feature-flags',
    title: 'Feature flags',
    summary: 'New behaviour ships behind a flag that defaults to off.',
  }),
]

/**
 * The board's merged catalog: the built-ins, the account's two and the board's three, as the
 * tiers merge them (a later tier overrides an earlier one by id).
 */
export const layeredCatalog: ResolvedFragment[] = [
  ...fragmentCatalog,
  ...accountFragments.map((f) => ({ ...f, tier: 'account' as const })),
  ...workspaceFragments.map((f) => ({ ...f, tier: 'workspace' as const })),
]
