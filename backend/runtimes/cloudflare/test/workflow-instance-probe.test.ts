import { createRecordingLogger } from '@cat-factory/kernel'
import type { Workflow, WorkflowInstance } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { WorkflowsLookup } from '../src/infrastructure/workflows/sweeper'

// What `WorkflowsLookup` tells the stale-run sweeper about a run's durable instance, which is
// the whole input to a decision that can stop a live run or re-drive a healthy one.
//
// The property under test is that the probe never answers a state it has not established.
// Before this, BOTH throw paths answered `missing` ("the instance was lost, re-create it"), so
// a Workflows API outage read as every stale run losing its instance simultaneously and the
// sweeper re-drove the fleet with no log line to say why; and every status outside a
// four-member alive set fell through to `terminal` ("the instance is dead, stop the run"),
// which caught Workflows' own `unknown` answer and a run that was in the middle of pausing.

/** A `Workflow` binding whose `get` behaves as the case needs. Only `get` is ever called. */
function workflowWith(get: (id: string) => Promise<WorkflowInstance>): Workflow {
  return { get } as unknown as Workflow
}

/** A binding whose instance reports `status` (and optionally an error), like a live one. */
function workflowReporting(status: string, error?: { name: string; message: string }): Workflow {
  return workflowWith(async () =>
    Object.assign(Object.create(null), {
      status: async () => ({ status, ...(error ? { error } : {}) }),
    }),
  )
}

/** A binding whose `get` rejects with `error`. */
function workflowRejecting(error: unknown): Workflow {
  return workflowWith(async () => {
    throw error
  })
}

describe('WorkflowsLookup: a probe answers only what it established', () => {
  it('reports a genuinely absent instance as missing', async () => {
    // The code Workflows raises for "no instance with this id", in both spellings it reaches
    // us in: the bare code from the local binding and the prefixed form from the API.
    for (const message of ['instance.not_found', '(instance.not_found) Instance does not exist']) {
      const probe = await new WorkflowsLookup(workflowRejecting(new Error(message))).instanceState(
        'run_1',
      )
      expect(probe.state).toBe('missing')
    }
  })

  it('reports a failed lookup as unknown, not missing, and names the cause', async () => {
    const logger = createRecordingLogger()
    const probe = await new WorkflowsLookup(
      workflowRejecting(new Error('workflows API unavailable')),
      logger,
    ).instanceState('run_1')

    // `missing` here is what turns one outage into a fleet-wide re-drive.
    expect(probe.state).toBe('unknown')
    expect(probe.detail).toContain('workflows API unavailable')
    expect(logger.lines.some((l) => l.level === 'warn' && l.fields.runId === 'run_1')).toBe(true)
  })

  it('reports an unreadable status as unknown', async () => {
    const logger = createRecordingLogger()
    const workflow = workflowWith(async () =>
      Object.assign(Object.create(null), {
        status: async () => {
          throw new Error('status read failed')
        },
      }),
    )

    const probe = await new WorkflowsLookup(workflow, logger).instanceState('run_1')
    expect(probe.state).toBe('unknown')
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it("treats Workflows' own unknown status as unknown rather than terminal", async () => {
    const probe = await new WorkflowsLookup(workflowReporting('unknown')).instanceState('run_1')
    // Falling through to `terminal` took the most destructive disposition available on the one
    // answer that carries no information: it stops the run.
    expect(probe.state).toBe('unknown')
  })

  it('leaves an instance that is finishing work before pausing alone', async () => {
    const probe = await new WorkflowsLookup(workflowReporting('waitingForPause')).instanceState(
      'run_1',
    )
    expect(probe.state).toBe('alive')
  })

  it.each(['running', 'queued', 'waiting', 'paused'])('reports %s as alive', async (status) => {
    expect((await new WorkflowsLookup(workflowReporting(status)).instanceState('r')).state).toBe(
      'alive',
    )
  })

  it.each(['complete', 'errored', 'terminated'])('reports %s as terminal', async (status) => {
    expect((await new WorkflowsLookup(workflowReporting(status)).instanceState('r')).state).toBe(
      'terminal',
    )
  })

  it("carries a terminal instance's own error as the probe detail", async () => {
    const probe = await new WorkflowsLookup(
      workflowReporting('errored', { name: 'Error', message: 'step exceeded its retries' }),
    ).instanceState('run_1')

    expect(probe.state).toBe('terminal')
    expect(probe.detail).toBe('Error: step exceeded its retries')
  })

  it('says nothing rather than empty for a terminal instance that reported no error', async () => {
    // A `detail` of `''` would render as an instance that explained itself and said nothing;
    // absent says it ended without an error, which is the ordinary completed case.
    const probe = await new WorkflowsLookup(workflowReporting('complete')).instanceState('run_1')
    expect(probe.detail).toBeUndefined()
  })

  it('scrubs and caps the error text it carries onto the run', async () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'
    const probe = await new WorkflowsLookup(
      workflowReporting('errored', {
        name: 'Error',
        message: `push rejected using ${secret} ${'x'.repeat(1000)}`,
      }),
    ).instanceState('run_1')

    // The instance error echoes the step's own throw, and this string is persisted on the run
    // and rendered in its details.
    expect(probe.detail).not.toContain(secret)
    expect((probe.detail ?? '').length).toBeLessThanOrEqual(401)
  })
})
