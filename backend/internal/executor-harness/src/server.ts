import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  type BlueprintJob,
  type BlueprintResult,
  type BootstrapJob,
  type BootstrapResult,
  type CiFixerJob,
  type CiFixerResult,
  type ConflictResolverJob,
  type ConflictResolverResult,
  type MergerJob,
  type MergerResult,
  type SpecJob,
  type SpecResult,
  parseBlueprintJob,
  parseBootstrapJob,
  parseCiFixerJob,
  parseConflictResolverJob,
  parseMergerJob,
  parseSpecJob,
  parseJob,
  type RunResult,
} from './job.js'
import { handleBootstrap } from './bootstrap.js'
import { handleBlueprint } from './blueprint.js'
import { handleSpec } from './spec.js'
import { handleCiFixer } from './ci-fixer.js'
import { handleConflictResolver } from './conflict-resolver.js'
import { handleMerger } from './merger.js'
import { redactSecrets } from './git.js'
import { JobRegistry, loadRunnerLimits } from './runner.js'
import { handleRun } from './runner.js'
import { log } from './logger.js'

// The container's HTTP entry point. The Worker addresses one instance per run and
// POSTs a job to /run; the harness starts that job in the background (bounded by
// an inactivity + max-duration watchdog) and returns a job id, which the Worker
// then polls via GET /jobs/{id}. Nothing here holds long-lived secrets — the
// per-job GitHub + proxy tokens arrive in the request body and live only for the
// duration of the job in an ephemeral workspace.

const PORT = Number(process.env.PORT ?? 8080)

// Optional inbound auth. When HARNESS_SHARED_SECRET is set, every non-health
// request must present a matching `x-harness-secret` header (constant-time
// compared). When it is unset the harness behaves as before (open), so local/dev
// and the existing acceptance flow keep working without configuration.
// TODO(worker): when a secret is configured, CloudflareContainerTransport should
// send the same `x-harness-secret` header on its /run and /jobs fetches. Left to
// the worker-side change to avoid conflicting with parallel work on that package.
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

// One registry per container process. Each run addresses its own container
// instance (one Durable Object id per execution / bootstrap job), so these track
// that instance's single job. Implementation (`/run`) and bootstrap
// (`/bootstrap`) jobs share the same watchdog/lifecycle but produce different
// results, so they get their own registries; `GET /jobs/{id}` checks both (job
// ids never collide across them).
const limits = loadRunnerLimits()
const jobs = new JobRegistry(limits)
const bootstrapJobs = new JobRegistry<BootstrapJob, BootstrapResult>(limits, handleBootstrap)
const blueprintJobs = new JobRegistry<BlueprintJob, BlueprintResult>(limits, handleBlueprint)
const specJobs = new JobRegistry<SpecJob, SpecResult>(limits, handleSpec)
const ciFixerJobs = new JobRegistry<CiFixerJob, CiFixerResult>(limits, handleCiFixer)
const conflictResolverJobs = new JobRegistry<ConflictResolverJob, ConflictResolverResult>(
  limits,
  handleConflictResolver,
)
const mergerJobs = new JobRegistry<MergerJob, MergerResult>(limits, handleMerger)

// Re-exported so the acceptance suite (and any direct caller) can run a job
// synchronously without going through the async job API.
export { handleRun }

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
    // Start (or re-attach to) a bootstrap job: POST /bootstrap. Like /run it
    // returns immediately with the job id; the Worker polls GET /jobs/{id} for
    // live subtask progress and the final result.
    if (req.method === 'POST' && req.url === '/bootstrap') {
      try {
        const job = parseBootstrapJob(JSON.parse(await readBody(req)))
        const view = bootstrapJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        // Parse failures (incl. host-allowlist rejection) are client errors → 400.
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start bootstrap', { error: message })
        return send(res, 400, { error: message } satisfies BootstrapResult)
      }
    }
    // Start (or re-attach to) a blueprint job: POST /blueprint. Like /bootstrap it
    // returns immediately with the job id; the Worker polls GET /jobs/{id} for live
    // subtask progress and the final decomposition tree.
    if (req.method === 'POST' && req.url === '/blueprint') {
      try {
        const job = parseBlueprintJob(JSON.parse(await readBody(req)))
        const view = blueprintJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start blueprint', { error: message })
        return send(res, 400, { error: message } satisfies BlueprintResult)
      }
    }
    // Start (or re-attach to) a spec job: POST /spec. Clones (or creates) the
    // implementation branch, (re)generates the unified specification document and
    // commits the `spec/` folder onto the branch.
    if (req.method === 'POST' && req.url === '/spec') {
      try {
        const job = parseSpecJob(JSON.parse(await readBody(req)))
        const view = specJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start spec', { error: message })
        return send(res, 400, { error: message } satisfies SpecResult)
      }
    }
    // Start (or re-attach to) a CI-fixer job: POST /ci-fix. Clones the PR branch,
    // fixes failing CI and pushes back onto the same branch.
    if (req.method === 'POST' && req.url === '/ci-fix') {
      try {
        const job = parseCiFixerJob(JSON.parse(await readBody(req)))
        const view = ciFixerJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start ci-fix', { error: message })
        return send(res, 400, { error: message } satisfies CiFixerResult)
      }
    }
    // Start (or re-attach to) a conflict-resolver job: POST /resolve-conflicts.
    // Clones the PR branch, merges the base in, resolves the conflicts and pushes
    // back onto the same branch so the PR becomes mergeable.
    if (req.method === 'POST' && req.url === '/resolve-conflicts') {
      try {
        const job = parseConflictResolverJob(JSON.parse(await readBody(req)))
        const view = conflictResolverJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start conflict-resolve', { error: message })
        return send(res, 400, { error: message } satisfies ConflictResolverResult)
      }
    }
    // Start (or re-attach to) a merger job: POST /merge. Clones the PR branch and
    // returns a JSON assessment (no commits).
    if (req.method === 'POST' && req.url === '/merge') {
      try {
        const job = parseMergerJob(JSON.parse(await readBody(req)))
        const view = mergerJobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start merge', { error: message })
        return send(res, 400, { error: message } satisfies MergerResult)
      }
    }
    // Poll a running/finished job: GET /jobs/{id}. Job ids are unique per kind, so
    // check each registry in turn (implementation, bootstrap, blueprint, ci-fix,
    // resolve-conflicts, merge).
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length))
      const view =
        jobs.get(id) ??
        bootstrapJobs.get(id) ??
        blueprintJobs.get(id) ??
        specJobs.get(id) ??
        ciFixerJobs.get(id) ??
        conflictResolverJobs.get(id) ??
        mergerJobs.get(id)
      if (!view) return send(res, 404, { error: 'job not found' })
      return send(res, 200, view)
    }
    // Start (or re-attach to) an implementation job: POST /run. Returns
    // immediately with the job id; the Worker polls GET /jobs/{id} for the result.
    if (req.method === 'POST' && req.url === '/run') {
      try {
        const job = parseJob(JSON.parse(await readBody(req)))
        // Idempotent: a re-dispatched /run (Workflows replay) re-attaches to the
        // job already running for this id rather than starting a duplicate.
        const view = jobs.start(job.jobId, job)
        return send(res, 202, { jobId: view.id, state: view.state })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        log.error('failed to start run', { error: message })
        return send(res, 400, { error: message } satisfies RunResult)
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
