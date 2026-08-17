import type { CatFactoryClient, CreatePublicTask } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import type { AcceptanceConfig } from '../src/config.ts'
import { filePinnedTask } from '../src/publicApi.ts'

// `filePinnedTask` is the suite's ONE door onto task creation, which is what makes its own bugs
// expensive: every scenario's work goes through it, and each of the two pinned here is silent. A
// dropped attachment leaves a run building against a corpus that is missing a document nobody
// mentioned, and a refusal the surface would have accepted aborts a scenario wearing the face of a
// suite bug.

const config = { modelPresetId: 'mdp_claude' } as AcceptanceConfig

/** A deployment that records the body rather than filing anything. */
function client(): { filed: Record<string, unknown>[]; client: CatFactoryClient } {
  const filed: Record<string, unknown>[] = []
  return {
    filed,
    client: {
      tasks: {
        create: async (_serviceId: string, body: Record<string, unknown>) => {
          filed.push(body)
          return { id: 'tsk_1' }
        },
      },
    } as unknown as CatFactoryClient,
  }
}

/** The body one call would have sent. */
async function file(
  task: Omit<CreatePublicTask, 'modelPresetId'>,
): Promise<Record<string, unknown>> {
  const deployment = client()
  await filePinnedTask(deployment.client, config, 'svc_1', task)
  return deployment.filed[0] ?? {}
}

describe('filePinnedTask', () => {
  it('pins the pass model preset on every task, whatever else the caller sent', async () => {
    // The value of pinning is that every run of a pass runs on the model the pass names: a site that
    // forgot the field would resolve the workspace default instead and produce a result that reads
    // exactly like the others.
    const body = await file({ title: 'Add a health endpoint' })
    expect(body.modelPresetId).toBe('mdp_claude')
  })

  it('JOINS the brief attachment to documents the caller already attached', async () => {
    // Spread after `...task` (which is what reads naturally) the brief's own `documents` array wins
    // outright, so a scenario attaching a source-backed spec beside a long brief lost the spec with no
    // error and no log line, and the run proceeded against an incomplete corpus.
    const body = await file({
      title: 'Stand up the catalog API',
      description: 'x'.repeat(2_500),
      documents: [{ kind: 'source', source: 'notion', ref: 'https://notion.example/spec' }],
    })
    const documents = body.documents as { kind: string }[]
    expect(documents.map((document) => document.kind)).toEqual(['source', 'upload'])
  })

  it('files an EMPTY description as the surface accepts it, rather than refusing', async () => {
    // `briefFields` refuses a brief with no text, and `createPublicTaskSchema` accepts one: this door
    // may not be stricter than the route it drives, or a titles-only task aborts the scenario.
    const body = await file({ title: 'Investigate the flake', description: '' })
    expect(body.description).toBe('')
    expect('documents' in body).toBe(false)
  })

  it('leaves a brief that FITS exactly as it was, with nothing attached', async () => {
    // The property that makes the size branch safe to put in the shared path: under the cap, nothing
    // about the body changes.
    const body = await file({
      title: 'Add a health endpoint',
      description: 'Return 200 on /health.',
    })
    expect(body.description).toBe('Return 200 on /health.')
    expect('documents' in body).toBe(false)
  })
})
