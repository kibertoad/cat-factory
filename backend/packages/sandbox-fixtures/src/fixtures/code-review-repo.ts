import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// The REPO-SCALE code-review fixtures: a change spanning several files, delivered the way
// production delivers repository material to an agent that has no filesystem.
//
// Why this file exists separately from `code-review.ts`. In production the code `reviewer` is a
// CONTAINER-backed companion: it clones the producer's branch and reads the changed files itself, and
// its composed system prompt tells it to. A Sandbox cell is one inline LLM call with no checkout and
// no tools, so a fixture that hands it a single snippet in `priorOutputs` tests the reviewer on a
// task it will never see: the interesting failures of a real review (missing the one file that makes
// the other three wrong, reviewing the migration and the code that depends on it separately) only
// appear when there is more than one file.
//
// So the change arrives on `injectedContextFiles`, which is the SAME field the `pr-reviewer`'s preOps
// use to hand a reviewer its diff, and the same field `withInjectedContext` folds into the user
// prompt for any inline caller, stating in that fold that there is no checkout to read them from.
// Nothing is faked and nothing is invented: it is the production seam for exactly this
// situation. The run-driver additionally states the absent checkout to the candidate
// (`statesMissingCheckout`), so it is never graded on failing to run `git diff`.
//
// What this does NOT cover, deliberately: a kind whose deliverable is a pushed commit. Grading the
// `coder` needs a real container against a seed repository, which is why it is the one catalog entry
// marked un-runnable. See `docs/initiatives/sandbox-coverage-expansion.md`.

/**
 * Build a reviewer context whose change under review arrives as injected context files, with the
 * producer's short report in `priorOutputs` as the pointer it is in a real run.
 */
function repoReviewerContext(
  block: { title: string; type: string; description: string },
  report: string,
  files: { path: string; content: string }[],
): Record<string, unknown> {
  return {
    agentKind: 'reviewer',
    pipelineName: 'sandbox',
    stepIndex: 1,
    isFinalStep: true,
    block,
    priorOutputs: [{ agentKind: 'coder', output: report }],
    decisions: [],
    resolvedDecision: null,
    injectedContextFiles: files,
  }
}

const SETTINGS_CACHE_DIFF = [
  '# Change under review',
  '',
  'Branch `cat-factory/settings-cache` against `main`. 5 files changed, 118 insertions, 9 deletions.',
  '',
  '```',
  'A  src/cache/settingsCache.ts             | 44 ++++++++++',
  'M  src/services/SettingsService.ts        | 31 ++++---',
  'M  src/http/SettingsController.ts         | 12 ++++',
  'A  migrations/0042_add_settings_cached.sql |  3 +++',
  'A  src/cache/settingsCache.test.ts        | 28 +++++++',
  '```',
  '',
  '## src/cache/settingsCache.ts (added)',
  '',
  '```ts',
  'interface Entry {',
  '  value: WorkspaceSettings',
  '  expiresAt: number',
  '}',
  '',
  'const TTL_MS = 5 * 60 * 1000',
  '',
  'const entries = new Map<string, Entry>()',
  '',
  'export function cacheKey(workspaceId: string, key: string): string {',
  '  return key',
  '}',
  '',
  'export function readSettings(workspaceId: string, key: string): WorkspaceSettings | undefined {',
  '  const entry = entries.get(cacheKey(workspaceId, key))',
  '  if (!entry) return undefined',
  '  if (entry.expiresAt < Date.now()) {',
  '    entries.delete(cacheKey(workspaceId, key))',
  '    return undefined',
  '  }',
  '  return entry.value',
  '}',
  '',
  'export function writeSettings(',
  '  workspaceId: string,',
  '  key: string,',
  '  value: WorkspaceSettings,',
  '): void {',
  '  entries.set(cacheKey(workspaceId, key), { value, expiresAt: Date.now() + TTL_MS })',
  '}',
  '```',
  '',
  '## src/services/SettingsService.ts (modified)',
  '',
  '```diff',
  ' export class SettingsService {',
  '   constructor(private readonly deps: Deps) {}',
  ' ',
  '   async get(workspaceId: string, key: string): Promise<WorkspaceSettings> {',
  '-    return this.deps.repo.get(workspaceId, key)',
  '+    const cached = readSettings(workspaceId, key)',
  '+    if (cached) return cached',
  '+    const fresh = await this.deps.repo.get(workspaceId, key)',
  '+    writeSettings(workspaceId, key, fresh)',
  '+    return fresh',
  '   }',
  ' ',
  '   async update(',
  '     workspaceId: string,',
  '     key: string,',
  '     patch: Partial<WorkspaceSettings>,',
  '   ): Promise<WorkspaceSettings> {',
  '     const current = await this.deps.repo.get(workspaceId, key)',
  '     const next = { ...current, ...patch }',
  '     await this.deps.repo.upsert(workspaceId, key, next)',
  '     return next',
  '   }',
  ' }',
  '```',
  '',
  '## src/http/SettingsController.ts (modified)',
  '',
  '```diff',
  '   app.get("/workspaces/:workspaceId/settings/:key", async (c) => {',
  '-    const settings = await service.get(param(c, "workspaceId"), param(c, "key"))',
  '-    return c.json(structuredClone(settings), 200)',
  '+    const settings = await service.get(param(c, "workspaceId"), param(c, "key"))',
  '+    return c.json(settings, 200)',
  '   })',
  '+',
  '+  app.patch("/workspaces/:workspaceId/settings/:key", async (c) => {',
  '+    const body = c.req.valid("json")',
  '+    const updated = await service.update(param(c, "workspaceId"), param(c, "key"), body)',
  '+    return c.json(updated, 200)',
  '+  })',
  '```',
  '',
  '## migrations/0042_add_settings_cached.sql (added)',
  '',
  '```sql',
  '-- Record when a settings row was last read, for cache diagnostics.',
  'ALTER TABLE workspace_settings',
  '  ADD COLUMN last_read_at TIMESTAMPTZ NOT NULL;',
  '```',
  '',
  '## src/cache/settingsCache.test.ts (added)',
  '',
  '```ts',
  "describe('settingsCache', () => {",
  "  it('returns a cached value', () => {",
  "    writeSettings('ws-1', 'notifications', { muted: false })",
  "    expect(readSettings('ws-1', 'notifications')).toEqual({ muted: false })",
  '  })',
  '',
  "  it('expires an entry after the TTL', () => {",
  '    vi.useFakeTimers()',
  "    writeSettings('ws-1', 'notifications', { muted: false })",
  "    expect(readSettings('ws-1', 'notifications')).toBeDefined()",
  '    vi.useRealTimers()',
  '  })',
  '})',
  '```',
].join('\n')

export const CODE_REVIEW_REPO_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'review-settings-cache-multifile-complex',
    agentKind: 'reviewer',
    kind: 'code-review',
    name: 'Settings cache, five files (repo-scale)',
    difficulty: 'complex',
    summary:
      'A cache added across service, controller, migration and test, where the worst bugs are only visible by reading two files together.',
    payload: repoReviewerContext(
      {
        title: 'Cache workspace settings reads',
        type: 'service',
        description:
          'Workspace settings are read on nearly every request and change rarely. Cache them so the ' +
          'settings table stops being a hot path, and add an endpoint to update them.',
      },
      [
        'Added a TTL cache in front of the settings repository, wired it into `SettingsService.get`, ',
        'added the PATCH endpoint, a diagnostics column and unit tests for the cache. The settings ',
        'table is no longer read on every request.',
      ].join(''),
      [{ path: 'pr-diff.md', content: SETTINGS_CACHE_DIFF }],
    ),
    expectations: [
      exp(
        'cross-tenant-key',
        '`cacheKey` ignores `workspaceId` and returns the bare key, so one workspace serves another workspace’s settings.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The standout catch and a cross-tenant data leak. The function TAKES `workspaceId` and ' +
            'every call site passes it, so the signature reads correct at every call site: only the ' +
            'body gives it away. This is the finding that needs the new file and the service read ' +
            'together.',
          matchHints: [
            'cachekey',
            'ignores workspaceid',
            'workspace id is not',
            'cross-tenant',
            'cross tenant',
            'another workspace',
            'other tenant',
            'leak',
            'bare key',
          ],
        },
      ),
      exp(
        'no-invalidation-on-update',
        '`update` writes through the repository but never invalidates the cache, so every reader keeps the stale value for the full TTL.',
        {
          impact: 5,
          trickiness: 2,
          detail:
            'The headline correctness bug, and the one a single-file review of the cache cannot ' +
            'see: the cache file is fine in isolation. The PATCH endpoint added in the same change ' +
            'is what makes it reachable.',
          matchHints: [
            'invalidat*',
            'never cleared',
            'stale',
            'does not evict',
            'write-through',
            'update does not',
            'after update',
          ],
        },
      ),
      exp(
        'migration-not-null-no-default',
        'The migration adds a `NOT NULL` column with no default to an existing table, so it fails against real data.',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'It passes on an empty local database and fails on the first deploy with rows in the ' +
            'table. Needs either a default or a heal-then-constrain pass.',
          matchHints: [
            'not null',
            'no default',
            'existing rows',
            'default value',
            'backfill',
            'migration will fail',
            'nullable',
          ],
        },
      ),
      exp(
        'module-global-map',
        'The cache is a module-global Map, so it is per process: a scaled deployment cannot invalidate it and instances disagree.',
        {
          impact: 4,
          trickiness: 4,
          matchHints: [
            'module-level',
            'module global',
            'per process',
            'per-process',
            'multiple instances',
            'not shared',
            'horizontally',
            'in-memory only',
          ],
        },
      ),
      exp(
        'shared-mutable-reference',
        'The controller stopped cloning, so it returns the cached object itself: any downstream mutation corrupts the cache for every later reader.',
        {
          impact: 4,
          trickiness: 5,
          detail:
            'A DELETED line is the whole finding. `structuredClone` was there and the diff removes ' +
            'it, which reads as a tidy-up unless the reviewer connects it to the fact that the value ' +
            'is now shared rather than freshly fetched.',
          matchHints: [
            'structuredclone',
            'same object',
            'shared reference',
            'by reference',
            'mutate the cached',
            'clone',
            'copy',
          ],
        },
      ),
      exp(
        'vacuous-ttl-test',
        'The TTL test installs fake timers but never advances them, so it asserts the value is present and proves nothing about expiry.',
        {
          impact: 3,
          trickiness: 4,
          detail:
            'A green test that covers nothing is worse than a missing one: it reads as coverage. ' +
            'The test name claims expiry and the body never expires anything.',
          matchHints: [
            'never advance',
            'does not advance',
            'advancetimers',
            'fake timers',
            'vacuous',
            'tests nothing',
            'always pass',
            'never expires in the test',
          ],
        },
      ),
      exp(
        'shared-test-state',
        'Both tests write the same key into the module-global Map with no reset, so they leak into each other and into any other suite in the process.',
        {
          impact: 2,
          trickiness: 4,
          matchHints: [
            'shared state',
            'leak between tests',
            'no reset',
            'beforeeach',
            'clear the cache',
            'test isolation',
            'order dependent',
          ],
        },
      ),
    ],
    notes:
      'The repo-scale fixture, and the one that measures what a multi-file review is FOR: four of the ' +
      'seven findings are invisible in any single file. Two of them (the cache key and the removed ' +
      'clone) are the strongest signal in the whole library, because both read as correct locally.',
  },
]
