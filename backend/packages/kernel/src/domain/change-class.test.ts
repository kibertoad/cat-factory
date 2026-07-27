import { describe, expect, it } from 'vitest'
import {
  CHANGE_CLASS_RANK,
  classifyChangedFiles,
  classifyChangedPath,
  resolveMergeClassRule,
} from './change-class.js'

describe('classifyChangedPath', () => {
  it.each([
    ['README.md', 'docs'],
    ['docs/architecture.md', 'docs'],
    ['LICENSE', 'docs'],
    ['CHANGELOG.md', 'docs'],
    ['frontend/app/i18n/locales/en.json', 'docs'],
    ['guide.rst', 'docs'],
  ])('classifies %s as docs', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it.each([
    ['src/login.test.ts', 'test'],
    ['src/login.spec.tsx', 'test'],
    ['backend/internal/e2e/tests/board.spec.ts', 'test'],
    ['pkg/thing_test.go', 'test'],
    ['app/__tests__/helper.ts', 'test'],
    ['test/fixtures/payload.json', 'test'],
    ['tests/test_users.py', 'test'],
  ])('classifies %s as test', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it.each([
    ['package.json', 'dependency'],
    ['pnpm-lock.yaml', 'dependency'],
    ['backend/packages/kernel/package.json', 'dependency'],
    ['Cargo.lock', 'dependency'],
    ['go.mod', 'dependency'],
    ['requirements.txt', 'dependency'],
  ])('classifies %s as dependency', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it.each([
    ['.github/workflows/ci.yml', 'config'],
    ['Dockerfile', 'config'],
    ['docker-compose.yml', 'config'],
    ['tsconfig.build.json', 'config'],
    ['vitest.config.ts', 'config'],
    ['infra/main.tf', 'config'],
    ['.oxlintrc.json', 'config'],
    ['deploy/backend/wrangler.toml', 'config'],
    ['k8s/api/deployment.yaml', 'config'],
    ['.github/workflows/release.yml', 'config'],
  ])('classifies %s as config', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  // The safety floor under the directory-segment heuristics: a per-class `always` rule keys off
  // this classification, so executable code filed under a docs/deploy/CI directory must NOT be
  // demoted to the prose or config bucket — otherwise "always auto-merge docs" silently
  // auto-merges a TypeScript change with the merger's scores never consulted.
  it.each([
    ['deploy/node/src/main.ts', 'source'],
    ['docs/scripts/build-diagrams.ts', 'source'],
    ['docs/tooling/generate.py', 'source'],
    ['.github/scripts/release.mjs', 'source'],
    ['k8s/operator/main.go', 'source'],
    ['terraform/lambda/handler.js', 'source'],
    ['deploy/local/bin/start.sh', 'source'],
  ])(
    'classifies executable source under a docs/config directory as source: %s',
    (path, expected) => {
      expect(classifyChangedPath(path)).toBe(expected)
    },
  )

  // ...but the floor does NOT reach past the checks that come before it: what a file IS still
  // beats where it lives.
  it.each([
    ['backend/runtimes/node/drizzle/0001_init/migration.ts', 'schema'],
    ['alembic/versions/abc.py', 'schema'],
    ['docs/examples/widget.test.ts', 'test'],
    ['deploy/node/src/main.spec.ts', 'test'],
  ])('keeps the schema/test classification for %s', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it.each([
    ['backend/runtimes/cloudflare/migrations/0061_x.sql', 'schema'],
    ['backend/runtimes/node/drizzle/20260101_x/migration.sql', 'schema'],
    ['backend/runtimes/node/src/db/schema.ts', 'schema'],
    ['alembic/versions/abc.py', 'schema'],
  ])('classifies %s as schema', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it.each([
    ['src/login.ts', 'source'],
    ['frontend/app/app/components/board/BlockNode.vue', 'source'],
    ['cmd/server/main.go', 'source'],
    ['assets/logo.svg', 'source'],
  ])('classifies %s as source', (path, expected) => {
    expect(classifyChangedPath(path)).toBe(expected)
  })

  it('never returns unknown for a real path (unknown means "no file list at all")', () => {
    // The contract the merge policy leans on: only an ABSENT changed-file list yields `unknown`,
    // and `unknown` is the one class no per-class rule may match.
    for (const path of ['weird', 'a/b/c', '.hidden', 'x.qqq']) {
      expect(classifyChangedPath(path)).not.toBe('unknown')
    }
  })

  it('prefers the more specific rule when a path could match two (a .md test fixture is a test)', () => {
    // Ordering, not chance: the test check runs before the docs check, so a Markdown snapshot
    // fixture reads as a test rather than as documentation.
    expect(classifyChangedPath('src/__snapshots__/render.md')).toBe('test')
    // And a .sql migration is schema even though it sits under a config-ish directory.
    expect(classifyChangedPath('deploy/migrations/0001_init.sql')).toBe('schema')
  })
})

describe('classifyChangedFiles', () => {
  it('takes the highest-ranked class present in a mixed diff', () => {
    // The precedence rule that makes a per-class rule safe: one touched source file lifts a
    // dependency bump to `source`, so "always auto-merge dependency" can never fire on it.
    expect(classifyChangedFiles(['package.json', 'src/a.ts'])).toEqual({
      changeClass: 'source',
      fileCount: 2,
    })
    expect(classifyChangedFiles(['README.md', 'src/a.test.ts'])).toEqual({
      changeClass: 'test',
      fileCount: 2,
    })
    expect(classifyChangedFiles(['src/a.ts', 'migrations/0001.sql'])).toEqual({
      changeClass: 'schema',
      fileCount: 2,
    })
  })

  it('is order-independent', () => {
    const paths = ['docs/a.md', 'src/b.ts', 'package.json', 'migrations/0001.sql']
    const forward = classifyChangedFiles(paths)
    const reversed = classifyChangedFiles([...paths].reverse())
    expect(forward).toEqual(reversed)
    expect(forward.changeClass).toBe('schema')
  })

  it('yields unknown with a zero count for an empty or blank-only list', () => {
    expect(classifyChangedFiles([])).toEqual({ changeClass: 'unknown', fileCount: 0 })
    expect(classifyChangedFiles(['', '  '])).toEqual({ changeClass: 'unknown', fileCount: 0 })
  })

  it('classifies a pure single-class diff as that class', () => {
    expect(classifyChangedFiles(['package.json', 'pnpm-lock.yaml']).changeClass).toBe('dependency')
    expect(classifyChangedFiles(['docs/a.md', 'README.md']).changeClass).toBe('docs')
  })

  it('ranks schema above source and source above every lower-risk class', () => {
    // Pinned explicitly: the ordering IS the policy, so a silent reshuffle would change which
    // rule a mixed diff resolves to.
    expect(CHANGE_CLASS_RANK.schema).toBeGreaterThan(CHANGE_CLASS_RANK.source)
    expect(CHANGE_CLASS_RANK.source).toBeGreaterThan(CHANGE_CLASS_RANK.config)
    expect(CHANGE_CLASS_RANK.config).toBeGreaterThan(CHANGE_CLASS_RANK.dependency)
    expect(CHANGE_CLASS_RANK.dependency).toBeGreaterThan(CHANGE_CLASS_RANK.test)
    expect(CHANGE_CLASS_RANK.test).toBeGreaterThan(CHANGE_CLASS_RANK.docs)
    expect(CHANGE_CLASS_RANK.docs).toBeGreaterThan(CHANGE_CLASS_RANK.unknown)
  })
})

describe('resolveMergeClassRule', () => {
  it('falls back to thresholds for an absent class or an absent map', () => {
    expect(resolveMergeClassRule({}, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule(undefined, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule(null, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule({ docs: 'always' }, 'source')).toBe('thresholds')
  })

  it('returns the explicit rule for a class that has one', () => {
    expect(resolveMergeClassRule({ docs: 'always' }, 'docs')).toBe('always')
    expect(resolveMergeClassRule({ schema: 'never' }, 'schema')).toBe('never')
    expect(resolveMergeClassRule({ source: 'thresholds' }, 'source')).toBe('thresholds')
  })

  it('NEVER matches a rule for `unknown`, even one somehow stored for it', () => {
    // The load-bearing invariant: a diff we could not read must fall back to the score
    // comparison, so a transient VCS outage can neither widen nor tighten merge policy. The
    // wire schema rejects an `unknown` rule, and this is the second line of defence.
    expect(resolveMergeClassRule({ unknown: 'always' } as never, 'unknown')).toBe('thresholds')
    expect(resolveMergeClassRule({ unknown: 'never' } as never, 'unknown')).toBe('thresholds')
  })
})
