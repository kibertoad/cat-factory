import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type BootstrapResult, parseBootstrapJob, parseJob, type RunResult } from './job.js'
import { handleBootstrap } from './bootstrap.js'
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

// One registry per container process. Each run addresses its own container
// instance (one Durable Object id per execution), so this tracks that run's job.
const jobs = new JobRegistry(loadRunnerLimits())

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
    if (req.method === 'POST' && req.url === '/bootstrap') {
      try {
        const job = parseBootstrapJob(JSON.parse(await readBody(req)))
        const result = await handleBootstrap(job)
        return send(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return send(res, 500, { error: message } satisfies BootstrapResult)
      }
    }
    // Poll a running/finished job: GET /jobs/{id}.
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length))
      const view = jobs.get(id)
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
        const message = error instanceof Error ? error.message : String(error)
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
    console.log(`implementer-harness listening on :${PORT}`)
  })
}

export { server }
