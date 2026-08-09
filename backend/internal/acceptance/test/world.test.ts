import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coerceWorld, readWorld, resolveRunId, WorldStore } from '../src/world.ts'

// The ledger is what makes a re-run resume instead of re-bootstrapping two repositories, so the
// properties tested here are the ones whose failure costs an afternoon of real model spend:
// a patch that does not survive the process, and a malformed file that stops the suite dead.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cf-acceptance-'))
}

describe('resolveRunId', () => {
  it('honours a pinned id, which is how a re-run resumes', () => {
    expect(resolveRunId({ ACCEPTANCE_RUN_ID: '20260809T1200' })).toBe('20260809T1200')
  })

  it('ignores a blank pin rather than minting an empty run id', () => {
    expect(resolveRunId({ ACCEPTANCE_RUN_ID: '  ' })).not.toBe('')
  })

  it('mints an id usable in a repository name', () => {
    // It becomes part of a GitHub repository name, where the character set is narrow.
    expect(resolveRunId({})).toMatch(/^[0-9]+$/)
  })
})

describe('WorldStore', () => {
  it('persists a patch so a later process sees it', () => {
    const dir = scratch()
    const first = new WorldStore(dir, 'run-1')
    first.patch({
      backend: { blockId: 'blk_1', serviceId: 'blk_1', repoName: 'api', repoUrl: null },
    })

    // A fresh store over the same directory is the crash-and-resume case, which is the whole
    // reason the ledger is a file rather than module state.
    const resumed = new WorldStore(dir, 'run-1')
    expect(resumed.value.backend?.blockId).toBe('blk_1')
  })

  it('keeps runs apart by id, so two passes never read each other', () => {
    const dir = scratch()
    new WorldStore(dir, 'run-1').patch({ frontend: emptyService() })
    expect(new WorldStore(dir, 'run-2').value.frontend).toBeNull()
  })

  it('names the missing record and how to recover when a spec reads one too early', () => {
    const store = new WorldStore(scratch(), 'run-1')
    // The message is the deliverable: this fires when someone runs spec 03 alone, and "cannot
    // read properties of null" would send them into the harness instead of at the ledger.
    expect(() => store.require('backend')).toThrow(/ACCEPTANCE_RUN_ID/)
    expect(() => store.require('backend')).toThrow(/backend/)
  })

  it('returns the merged world from a patch', () => {
    const store = new WorldStore(scratch(), 'run-1')
    store.patch({ backend: emptyService() })
    const merged = store.patch({ frontend: emptyService() })
    expect(merged.backend).not.toBeNull()
    expect(merged.frontend).not.toBeNull()
  })
})

describe('readWorld', () => {
  it('treats an absent ledger as a first run', () => {
    expect(readWorld(join(scratch(), 'nope.json'))).toBeNull()
  })

  it('discards a malformed ledger rather than refusing to start', () => {
    // Deliberate: the ledger caches ids, so ignoring a corrupt one costs a fresh pass, whereas
    // refusing to start over a stray byte blocks the suite entirely.
    const path = join(scratch(), 'broken.json')
    writeFileSync(path, '{ this is not json', 'utf8')
    expect(readWorld(path)).toBeNull()
  })
})

describe('coerceWorld', () => {
  it('rejects a value with no run id', () => {
    expect(coerceWorld({ backend: emptyService() })).toBeNull()
    expect(coerceWorld(null)).toBeNull()
    expect(coerceWorld('run-1')).toBeNull()
  })

  it('drops a half-written record instead of surfacing a partial one', () => {
    // A record missing `blockId` would otherwise reach `require('backend')` and be used as a
    // service id, which fails much later against the deployment as an opaque 404.
    const world = coerceWorld({ runId: 'run-1', backend: { serviceId: 'blk_1' } })
    expect(world?.backend).toBeNull()
  })

  it('carries every record through when they are whole', () => {
    const world = coerceWorld({
      runId: 'run-1',
      backend: emptyService(),
      frontend: emptyService(),
      featureBackend: { taskId: 'tsk_1', runId: 'run_1', pullRequestUrl: 'https://example/pr/1' },
      featureFrontend: { taskId: 'tsk_2' },
      bugfix: { taskId: 'tsk_3', runId: 'run_3' },
    })
    expect(world?.featureBackend?.pullRequestUrl).toBe('https://example/pr/1')
    // A run recorded before it had a runId is a real intermediate state (spec 03 writes one), so
    // the missing halves become null rather than dropping the whole record.
    expect(world?.featureFrontend).toEqual({
      taskId: 'tsk_2',
      runId: null,
      pullRequestUrl: null,
    })
    expect(world?.bugfix?.runId).toBe('run_3')
  })
})

function emptyService() {
  return { blockId: 'blk_x', serviceId: 'blk_x', repoName: 'repo', repoUrl: null }
}
