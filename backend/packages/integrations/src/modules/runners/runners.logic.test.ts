import type { RunnerPoolManifest } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { classifyJobStatus, manifestWarnings } from './runners.logic.js'

// The pure half of the runner-pool poll: turning an arbitrary scheduler's status word into
// the canonical job state, and — crucially — telling a job that FAILED apart from a runner
// that VANISHED, since only the latter should be retried on a fresh pool member.

describe('classifyJobStatus', () => {
  const cases: {
    raw: string | undefined
    state: 'running' | 'done' | 'failed'
    evicted?: 'crash'
    why: string
  }[] = [
    { raw: undefined, state: 'running', why: 'no status reported at all' },
    { raw: '   ', state: 'running', why: 'a blank status is an ABSENT one, not a word' },
    { raw: 'running', state: 'running', why: 'the canonical literal' },
    { raw: 'RUNNING', state: 'running', why: 'case-insensitive' },
    { raw: '  Evicted  ', state: 'failed', evicted: 'crash', why: 'padding is not a new word' },
    { raw: 'queued', state: 'running', why: 'a queue state is not a death' },
    { raw: 'provisioning', state: 'running', why: 'a queue state is not a death' },
    {
      raw: 'unschedulable',
      state: 'running',
      // Kubernetes reports `Unschedulable` on a PENDING pod while the cluster autoscales, so
      // failing on it would kill a live run on its FIRST poll — the wrong-kill class this
      // classification exists to avoid. A pool that means it terminally maps it explicitly.
      why: 'a capacity wait, not a death',
    },
    { raw: 'wibble', state: 'running', why: 'an unknown word must never kill a live run' },
    { raw: 'done', state: 'done', why: 'the canonical literal' },
    { raw: 'succeeded', state: 'done', why: 'a common success synonym' },
    { raw: 'completed', state: 'done', why: 'a common success synonym' },
    { raw: 'failed', state: 'failed', why: 'the canonical literal' },
    { raw: 'error', state: 'failed', why: 'a job-level failure, not an infra loss' },
    { raw: 'cancelled', state: 'failed', why: 'terminal; NOT an eviction (a human stopped it)' },
    { raw: 'killed', state: 'failed', why: 'terminal; NOT an eviction (a human stopped it)' },
    { raw: 'deadline_exceeded', state: 'failed', why: 'a job-level failure' },
    { raw: 'evicted', state: 'failed', evicted: 'crash', why: 'the runner was reclaimed' },
    { raw: 'preempted', state: 'failed', evicted: 'crash', why: 'the runner was reclaimed' },
    { raw: 'OOMKilled', state: 'failed', evicted: 'crash', why: 'the runner was reclaimed' },
    { raw: 'node_lost', state: 'failed', evicted: 'crash', why: 'the runner was reclaimed' },
  ]

  for (const c of cases) {
    it(`maps '${c.raw}' → ${c.state}${c.evicted ? ` (evicted)` : ''} — ${c.why}`, () => {
      expect(classifyJobStatus(c.raw, undefined)).toEqual(
        c.evicted ? { state: c.state, evicted: c.evicted } : { state: c.state },
      )
    })
  }

  it('lets the manifest statusMap override the built-in vocabulary', () => {
    // An operator whose scheduler says "error" while it retries internally can say so; the
    // built-in vocabulary is only the fallback for words the manifest never mapped.
    expect(classifyJobStatus('error', [{ from: 'error', to: 'running' }])).toEqual({
      state: 'running',
    })
    expect(classifyJobStatus('wibble', [{ from: 'wibble', to: 'done' }])).toEqual({ state: 'done' })
  })

  it('still tags an eviction when the manifest maps the word to a plain failure', () => {
    // The whole point of F4: a manifest saying `evicted → failed` is describing the STATE, not
    // declining the recovery. Without this the run terminally fails instead of trying a fresh
    // pool member.
    expect(classifyJobStatus('evicted', [{ from: 'evicted', to: 'failed' }])).toEqual({
      state: 'failed',
      evicted: 'crash',
    })
  })

  it('matches a statusMap entry through the same normalisation as the status', () => {
    // Both sides fold to the comparison form, so an operator's pretty-cased/padded mapping
    // entry still binds the scheduler's word — a mapping that silently missed would hand the
    // run back to the built-in vocabulary and quietly ignore what the operator declared.
    expect(classifyJobStatus('  Wibble ', [{ from: 'WIBBLE ', to: 'done' }])).toEqual({
      state: 'done',
    })
  })

  it('never tags an eviction on a non-failed state', () => {
    // A manifest that (oddly) maps `evicted → running` gets exactly that: the eviction verdict
    // only qualifies a failure, it can never invent one.
    expect(classifyJobStatus('evicted', [{ from: 'evicted', to: 'running' }])).toEqual({
      state: 'running',
    })
  })
})

describe('manifestWarnings', () => {
  const base: RunnerPoolManifest = {
    providerId: 'acme-pool',
    label: 'Acme',
    baseUrl: 'https://pool.test/api',
    auth: { type: 'none' },
    dispatch: { method: 'POST', pathTemplate: '/jobs' },
    poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
    release: { method: 'DELETE', pathTemplate: '/jobs/{{input.jobId}}' },
    response: { statusPath: 'state' },
  }

  it('reports nothing for a complete manifest', () => {
    expect(manifestWarnings(base)).toEqual([])
  })

  it('flags a manifest that can never cancel a job pool-side', () => {
    const { release: _release, ...withoutRelease } = base
    const warnings = manifestWarnings(withoutRelease as RunnerPoolManifest)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.code).toBe('runner_manifest_no_release')
    // The prose is the deployment log's copy (the SPA renders its own from the code), so it
    // must name the manifest it is about — an operator may run several.
    expect(warnings[0]!.message).toContain('no release template')
    expect(warnings[0]!.message).toContain('acme-pool')
  })

  it('flags a manifest whose poll can never report an outcome', () => {
    const warnings = manifestWarnings({ ...base, response: {} })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.code).toBe('runner_manifest_no_status_path')
    expect(warnings[0]!.message).toContain('no status path')
  })

  it('reports both gaps independently', () => {
    // They are unrelated defects with unrelated fixes, so a manifest missing both must hear
    // about both rather than the first one found.
    const { release: _release, ...withoutRelease } = base
    const warnings = manifestWarnings({ ...withoutRelease, response: {} } as RunnerPoolManifest)
    expect(warnings.map((w) => w.code)).toEqual([
      'runner_manifest_no_release',
      'runner_manifest_no_status_path',
    ])
  })
})
