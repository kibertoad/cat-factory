import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatFactoryApiError, type CatFactoryClient } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { passThroughCredentialRetry } from './client.js'
import { Journal } from './journal.js'
import { OperatorRefusal } from './operatorText.js'
import { fileAndDrive, type RunRecord } from './resume.js'
import { sdkTransportFailure } from './testing/sdkFailures.js'

// The create window, which is the one point in a pass that no ordering closes: the task id is minted
// on the far side of the request, so a create the deployment served and whose answer was lost leaves
// a task nothing on disk names. What this module can do about it is say which of the two happened,
// and these tests pin that it says opposite things for opposite causes rather than one hedge for
// both.
//
// Everything else in `resume.ts` (adopt, re-attach, re-file) drives a live run to terminal and is
// covered where those journeys are: the acceptance suite's own scenarios.

function options(createTask: () => Promise<{ taskId: string }>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'kit-resume-'))
  return {
    client: {} as CatFactoryClient,
    journal: new Journal(stateDir, 'run-1'),
    existing: null,
    createTask,
    pipelineId: 'pl_build',
    steer: 'implement exactly what the task says',
    budgetMs: 1_000,
    onRecord: (_record: RunRecord) => {},
    label: 'the catalog API scaffold',
    credentials: passThroughCredentialRetry,
    epilogue: 'nothing was cleaned up',
  }
}

async function refusalFrom(error: unknown): Promise<Error> {
  try {
    await fileAndDrive(options(() => Promise.reject(error)))
  } catch (failure) {
    return failure as Error
  }
  throw new Error('filing was expected to fail and did not')
}

describe('fileAndDrive, when the create does not complete', () => {
  it('says the task may exist when the failure leaves the server free to have acted', async () => {
    // A socket that died under the request is exactly the shape a deployment killed mid-response
    // produces, and it says nothing about whether the row was written first.
    const failure = await refusalFrom(
      await sdkTransportFailure({
        message: 'socket hang up',
        code: 'ECONNRESET',
        answeredCalls: 4,
      }),
    )
    expect(failure).toBeInstanceOf(OperatorRefusal)
    expect(failure.message).toContain('UNKNOWN')
    expect(failure.message).toContain('the catalog API scaffold')
    // The account is what tells the two readings apart, so it travels with the instruction.
    expect(failure.message).toContain('had answered 4 calls')
  })

  it('says nothing was created when no origin ever accepted the request', async () => {
    // The opposite instruction, and the reason the branch exists: sending an operator to search a
    // board after a refused connection is a minute spent proving something the cause already said.
    const failure = await refusalFrom(
      await sdkTransportFailure({
        message: 'connect ECONNREFUSED 127.0.0.1:8787',
        code: 'ECONNREFUSED',
      }),
    )
    expect(failure).toBeInstanceOf(OperatorRefusal)
    expect(failure.message).toContain('nothing was created')
    expect(failure.message).not.toContain('UNKNOWN')
  })

  it('leaves a refusal the DEPLOYMENT stated exactly as it arrived', async () => {
    // It carries a status, a machine-readable code and a request id, the task was NOT filed, and a
    // wrapper would bury all three under a sentence about a window this failure never opened.
    //
    // The real class, not a plain `Error` wearing its fields: nothing classifies one of those, so it
    // lands in the unanswered half and the test passes for the wrong reason (which is how the first
    // draft of this file passed while asserting the opposite of what it names).
    const answered = new CatFactoryApiError({
      status: 422,
      code: 'validation',
      message: 'title is required',
      requestId: 'req_19312e8862264172b1fa1051',
      body: { error: { code: 'validation', message: 'title is required' } },
    })
    const failure = await refusalFrom(answered)
    expect(failure).toBe(answered)
  })
})
