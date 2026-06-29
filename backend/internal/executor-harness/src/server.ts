import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { parseAgentJob } from './job.js'
import { handleAgent } from './agent.js'
import { redactSecrets } from './git.js'
import { JobRegistry, loadRunnerLimits, type JobResultBase, type RunOptions } from './runner.js'
import { log } from './logger.js'

// The container's HTTP entry point. The Worker addresses one instance per run and
// POSTs a job to /jobs (the body's `kind` selects which agent runs); the harness
// starts that job in the background (bounded by an inactivity + max-duration
// watchdog) and returns a job id, which the Worker then polls via GET /jobs/{id}.
// Nothing here holds long-lived secrets: the per-job GitHub + proxy tokens arrive
// in the request body and live only for the duration of the job in an ephemeral
// workspace.

const PORT = Number(process.env.PORT ?? 8080)

// Optional inbound auth. When HARNESS_SHARED_SECRET is set, every non-health
// request must present a matching `x-harness-secret` header (constant-time
// compared). When it is unset the harness behaves as before (open), so local/dev
// and the existing acceptance flow keep working without configuration.
// The direct callers send the matching header when the secret is configured: the
// local Docker transport (LocalContainerRunnerTransport) and the Cloudflare
// transport (CloudflareContainerTransport, which also injects the secret into the
// container env). A self-hosted runner pool reaches the harness through its own
// control plane, so its operator configures the secret pool-side.
const SHARED_SECRET = process.env.HARNESS_SHARED_SECRET

const HEADER = 'x-harness-secret'

/** Constant-time check of the shared-secret header; true when auth is disabled. */
function authorized(req: IncomingMessage): boolean {
  if (!SHARED_SECRET) return true
  const provided = req.headers[HEADER]
  const got = Buffer.from(Array.isArray(provided) ? (provided[0] ?? '') : (provided ?? ''))
  const want = Buffer.from(SHARED_SECRET)
  // Length check first; timingSafeEqual requires equal-length buffers.
  return got.length === want.length && timingSafeEqual(got, want)
}

// One registry per kind per container process. A run addresses its own container
// instance (one Durable Object id per execution / bootstrap job) and dispatches its
// sequence of step jobs to it; every kind shares the same watchdog/lifecycle but
// produces a different result, so each gets its own registry keyed by the job id.
const limits = loadRunnerLimits()

/** A dispatchable kind: how to validate its body and the registry that runs it. */
interface KindEntry {
  parse: (input: unknown) => { jobId: string }
  registry: JobRegistry<never, JobResultBase>
}

/** Pair a body validator with a registry running its handler under the shared limits. */
function defineKind<TJob extends { jobId: string }, TResult extends JobResultBase>(
  parse: (input: unknown) => TJob,
  handler: (job: TJob, opts: RunOptions) => Promise<TResult>,
  // Non-secret correlation fields bound on the per-job logger (see JobRegistry.describe).
  describe?: (job: TJob) => Record<string, unknown>,
): KindEntry {
  return {
    parse,
    registry: new JobRegistry<TJob, TResult>(limits, handler, describe),
  } as unknown as KindEntry
}

// The dispatch table. The harness now serves a SINGLE, manifest-driven kind: the
// generic `agent` (the job body's `mode` — explore | coding — and its data select the
// flow; WHAT the agent does is decided entirely by the backend). The per-kind bespoke
// handlers (run/blueprint/spec/explore/merge/test/…) were strangled onto this one kind
// and removed. A `POST /jobs` reads the body's `kind` to pick the entry; `GET /jobs/{id}`
// checks every registry (job ids never collide across kinds). `kind` mirrors kernel's
// `RunnerDispatchKind` (now also just `'agent'`); the harness keeps its own copy so the
// image carries no runtime deps.
const KINDS: Record<string, KindEntry> = {
  agent: defineKind(parseAgentJob, handleAgent, (job) => ({
    mode: job.mode,
    repo: `${job.repo.owner}/${job.repo.name}`,
    branch: job.branch,
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
    // All non-health endpoints are gated by the optional shared secret.
    if (!authorized(req)) {
      return send(res, 401, { error: 'unauthorized' })
    }
    // Poll a running/finished job: GET /jobs/{id}. Job ids are unique per kind, so
    // check each registry in turn; the first hit wins.
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length))
      for (const { registry } of Object.values(KINDS)) {
        const view = registry.get(id)
        if (view) return send(res, 200, view)
      }
      return send(res, 404, { error: 'job not found' })
    }
    // Start (or re-attach to) a job: POST /jobs with the kind in the body. The body's
    // `kind` selects the validator + registry; the rest is that kind's job spec.
    // Returns immediately with the job id; the caller polls GET /jobs/{id} for live
    // subtask progress and the final result. Idempotent: a re-dispatched POST
    // (a durable-driver replay) re-attaches to the job already running for the id
    // rather than starting a duplicate.
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
        // Parse failures (incl. host-allowlist rejection) are client errors → 400.
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

// Only auto-listen when run as the entry point (tests import handleRun directly).
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`executor-harness listening on :${PORT}`)
  })
}

export { server }
