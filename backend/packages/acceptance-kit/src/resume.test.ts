import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatFactoryApiError, type CatFactoryClient, CatFactoryDecodeError } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { passThroughCredentialRetry } from './client.js'
import { Journal } from './journal.js'
import { describeFailure, OperatorRefusal } from './operatorText.js'
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

/**
 * Drive a create to its failure and return what a pass would end on.
 *
 * `overrides` is what the pre-create stage needs: `prepareTask` and `createTask` are two stages
 * with opposite dispositions, so a test about the first cannot be written by rejecting the second.
 * Passing `null` for the error says the rejection is coming from an override instead.
 */
async function refusalFrom(
  error: unknown,
  overrides?: Partial<Parameters<typeof fileAndDrive>[0]>,
): Promise<Error> {
  try {
    await fileAndDrive({ ...options(() => Promise.reject(error)), ...overrides })
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

  it('treats a gateway status as unsettled, because the deployment did not write it', async () => {
    // A 504 arrives in the same shape as a refusal and is the opposite fact: `handleError` maps our
    // whole domain vocabulary onto 401/403/404/409/422/428/429/503, so nobody at the deployment
    // wrote this one. A proxy that gave up waiting for the upstream says nothing about whether the
    // upstream had already written the row, which is the whole question a create asks.
    const failure = await refusalFrom(
      new CatFactoryApiError({
        status: 504,
        code: 'unknown',
        message: 'upstream request timeout',
        requestId: null,
        body: '<html>gateway timeout</html>',
      }),
    )
    expect(failure).toBeInstanceOf(OperatorRefusal)
    expect(failure.message).toContain('UNKNOWN')
    // And it says whose answer it is: the sentence written for a transport failure claims an origin
    // history that a gateway's status does not carry.
    expect(failure.message).toContain("intermediary's own 504")
    expect(failure.message).not.toContain('had been answering this client')
  })

  it('reports what the SUITE threw as itself, whether or not the throw was a rejection', async () => {
    // The carve-out this replaced keyed on the throw being SYNCHRONOUS, which is not the same test:
    // a `createTask` written `async` (scenario 04's is) turns a refused brief into a rejection, and
    // a plain `Error` classifies as an unrecognised transport failure. Reported as a create of
    // unknown fate it sends an operator to search a board for a task nothing tried to file, and
    // hides the bug that stopped it being filed.
    const bug = new Error('A brief with no text describes no work.')
    const failure = await refusalFrom(bug)
    expect(failure).toBe(bug)
  })

  it('reports a failed pre-create READ as itself, not as a task that may exist', async () => {
    // The other half of the same rule, and the one no error type can settle: a body composed from
    // an evidence read fails in exactly the ways a create does, so what separates them is WHICH
    // stage was running. Nothing had been filed when this threw.
    const outage = await sdkTransportFailure({ message: 'socket hang up', code: 'ECONNRESET' })
    let created = false
    const failure = await refusalFrom(null, {
      prepareTask: () => Promise.reject(outage),
      createTask: () => {
        created = true
        return Promise.resolve({ taskId: 'tsk_never' })
      },
    })
    expect(created).toBe(false)
    expect(failure).toBe(outage)
  })

  it('does not claim an origin history where the failure carries none', async () => {
    // An answer nothing could read is in doubt for the same reason a reset is, and the sentence
    // written for a reset does not hold here: a `CatFactoryDecodeError` is a plain chain with no
    // verdict and no record of what this client had been served before. Telling an operator to read
    // one off it sends them looking for evidence that is not in the message.
    const failure = await refusalFrom(
      new CatFactoryDecodeError(
        'cat-factory SDK: POST /services/svc_1/tasks answered with a body that is not JSON.',
        '<!doctype html><title>Sign in</title>',
      ),
    )
    expect(failure).toBeInstanceOf(OperatorRefusal)
    expect(failure.message).toContain('UNKNOWN')
    expect(failure.message).not.toContain('had been answering this client')
    expect(failure.message).toContain('no verdict below')
  })

  it('prints the account once, which is what a reader of the refusal sees', async () => {
    // `describeFailure` is what renders a refusal, and it walks the cause chain: a refusal that
    // both interpolates the account AND carries the thrown value as its `cause` prints the errno
    // twice, under an instruction that already quoted it. The same duplication `transportAccount`
    // removes one layer down.
    const failure = await refusalFrom(
      await sdkTransportFailure({
        message: 'connect ECONNREFUSED 203.0.113.42:443',
        code: 'ECONNREFUSED',
        answeredCalls: 2,
      }),
    )
    const printed = describeFailure(failure)
    expect(printed.split('connect ECONNREFUSED 203.0.113.42:443')).toHaveLength(2)
  })
})
