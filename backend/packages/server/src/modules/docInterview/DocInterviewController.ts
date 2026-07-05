import {
  answerDocInterviewContract,
  continueDocInterviewContract,
  getDocInterviewContract,
  proceedDocInterviewContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

// ---------------------------------------------------------------------------
// Interactive document-interview endpoints (WS5). Drive the parked `doc-interviewer` gate
// from the interview window: `get` loads the current session; `answer` records one answer
// (no run resume); `continue`/`proceed` resume the parked run, running the (slow) interviewer
// LLM in the durable driver. All go through `executionService.docInterview` (undefined when the
// interviewer isn't wired → 503), and return the updated session. Mounted under
// `/workspaces/:workspaceId`.
// ---------------------------------------------------------------------------

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'The document interviewer is not configured' } },
    503,
  )

export function docInterviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const require = <E extends AppEnv>(c: Context<E>) =>
    c.get('container').executionService.docInterview ?? null

  buildHonoRoute(app, getDocInterviewContract, async (c) => {
    const interview = require(c)
    if (!interview) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await interview.getByBlock(param(c, 'workspaceId'), blockId), 200)
  })

  buildHonoRoute(app, answerDocInterviewContract, async (c) => {
    const interview = require(c)
    if (!interview) return unavailable(c)
    const { blockId } = c.req.valid('param')
    const { questionId, answer } = c.req.valid('json')
    return c.json(await interview.answer(param(c, 'workspaceId'), blockId, questionId, answer), 200)
  })

  buildHonoRoute(app, continueDocInterviewContract, async (c) => {
    const interview = require(c)
    if (!interview) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await interview.continue(param(c, 'workspaceId'), blockId), 200)
  })

  buildHonoRoute(app, proceedDocInterviewContract, async (c) => {
    const interview = require(c)
    if (!interview) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await interview.proceed(param(c, 'workspaceId'), blockId), 200)
  })

  return app
}
