import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { handleDeploy } from './deploy.js'
import { parseDeployJob } from './job.js'
import { redactSecrets } from './redact.js'
import { JobRegistry, loadRunnerLimits, type JobResultBase, type RunOptions } from './runner.js'
import { log } from './logger.js'

// The deploy container's HTTP entry point. The backend addresses one instance per run
// and POSTs a `deploy` job to /jobs; the harness starts that job in the background
// (bounded by an inactivity + max-duration watchdog) and returns a job id, which the
// backend then polls via GET /jobs/{id}. The contract is IDENTICAL to the executor
// harness (same /jobs + /jobs/{id} shape, same optional shared-secret gate), so the
// runner transport drives both the same way. Nothing here holds long-lived secrets: the
// per-job cluster token + git token arrive in the request body and live only for the job.

const PORT = Number(process.env.PORT ?? 8080)

// Optional inbound auth, identical to the executor harness: when HARNESS_SHARED_SECRET
// is set, every non-health request must present a matching `x-harness-secret` header
// (constant-time compared). Unset ⇒ open (local/dev).
const SHARED_SECRET = process.env.HARNESS_SHARED_SECRET
const HEADER = 'x-harness-secret'

function authorized(req: IncomingMessage): boolean {
  if (!SHARED_SECRET) return true
  const provided = req.headers[HEADER]
  const got = Buffer.from(Array.isArray(provided) ? (provided[0] ?? '') : (provided ?? ''))
  const want = Buffer.from(SHARED_SECRET)
  return got.length === want.length && timingSafeEqual(got, want)
}

const limits = loadRunnerLimits()

/** A dispatchable kind: how to validate its body and the registry that runs it. */
interface KindEntry {
  parse: (input: unknown) => { jobId: string }
  registry: JobRegistry<never, JobResultBase>
}

function defineKind<TJob extends { jobId: string }, TResult extends JobResultBase>(
  parse: (input: unknown) => TJob,
  handler: (job: TJob, opts: RunOptions) => Promise<TResult>,
  describe?: (job: TJob) => Record<string, unknown>,
): KindEntry {
  return {
    parse,
    registry: new JobRegistry<TJob, TResult>(limits, handler, describe),
  } as unknown as KindEntry
}

// The dispatch table. The deploy harness serves a single kind, `deploy`, mirroring
// kernel's RunnerDispatchKind. A `POST /jobs` reads the body's `kind` to pick the entry;
// `GET /jobs/{id}` checks every registry (job ids never collide across kinds).
const KINDS: Record<string, KindEntry> = {
  deploy: defineKind(parseDeployJob, handleDeploy, (job) => ({
    namespace: job.cluster.namespace,
    renderer: job.source.renderer,
    path: job.source.path,
  })),
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok' })
    }
    if (!authorized(req)) {
      return send(res, 401, { error: 'unauthorized' })
    }
    // Poll a running/finished job: GET /jobs/{id}.
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length))
      for (const { registry } of Object.values(KINDS)) {
        const view = registry.get(id)
        if (view) return send(res, 200, view)
      }
      return send(res, 404, { error: 'job not found' })
    }
    // Start (or re-attach to) a job: POST /jobs with the kind in the body. Idempotent —
    // a re-dispatched POST re-attaches to the job already running for the id.
    if (req.method === 'POST' && req.url === '/jobs') {
      let kind: unknown
      try {
        const raw = JSON.parse(await readBody(req)) as Record<string, unknown>
        kind = raw.kind
        const entry = typeof kind === 'string' ? KINDS[kind] : undefined
        if (!entry) {
          return send(res, 404, { error: `unknown job kind '${String(kind)}'` })
        }
        const job = entry.parse(raw)
        const view = entry.registry.start(job.jobId, job as never)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start job', {
          kind: typeof kind === 'string' ? kind : undefined,
          error: message,
        })
        return send(res, 400, { error: message })
      }
    }
    return send(res, 404, { error: 'not found' })
  })()
})

// Only auto-listen when run as the entry point (tests import the handlers directly).
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`deploy-harness listening on :${PORT}`)
  })
}

export { server }
