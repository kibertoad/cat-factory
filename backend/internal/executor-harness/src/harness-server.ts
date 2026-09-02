import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { HARNESS_BODY_CAPABILITIES } from './agent-capabilities.js'
import { parseAgentJob, parseInlineJob } from './job.js'
import { handleAgent } from './agent.js'
import { handleInline } from './inline.js'
import { redactSecrets } from './git.js'
import { readDockerStatus } from './docker-status.js'
import { reportedDockerWorkload } from './docker-capability.js'
import { harnessListenPort } from './harness-port.js'
import { JobRegistry, loadRunnerLimits, type JobResultBase, type RunOptions } from './runner.js'
import { log } from './logger.js'
import { HARNESS_VERSION } from './version.js'

// The container's HTTP entry point. The Worker addresses one instance per run and
// POSTs a job to /jobs (the body's `kind` selects which agent runs); the harness
// starts that job in the background (bounded by an inactivity + max-duration
// watchdog) and returns a job id, which the Worker then polls via GET /jobs/{id}.
// Nothing here holds long-lived secrets: the per-job GitHub + proxy tokens arrive
// in the request body and live only for the duration of the job in an ephemeral
// workspace.
//
// THE FILE NAME IS LOAD-BEARING, and so is {@link PROCESS_TITLE} below. This process is
// PID 1 of the job container, running as the same uid as the agent's own shell, so any
// pattern kill the agent runs can reach it. It used to be `dist/server.js`, which is
// also what an ordinary Node service builds to: a coder run that had just smoke-tested
// the service it wrote ran `pkill -f 'node dist/server.js'` to stop it, matched PID 1,
// and shut the harness down mid-job. The engine could only see a container that
// vanished, so it reported an eviction and re-dispatched into the same trap.

const PORT = harnessListenPort()

// Optional bind address. Default (unset) binds all interfaces — a container needs that for
// its published port. The native local transport runs the harness UNSANDBOXED on the
// developer's host and only ever connects over loopback, so it sets 127.0.0.1 to keep the
// agent-spawning API off the LAN.
const BIND_HOST = process.env.HARNESS_BIND_HOST?.trim() || undefined

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
    // The backend's correlation ids first, so EVERY line this job emits joins to the run in the
    // backend's own logs. Absent on a body from a backend older than the field — the rest of the
    // description is unaffected.
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
    ...(job.executionId ? { executionId: job.executionId } : {}),
    mode: job.mode,
    repo: `${job.repo.owner}/${job.repo.name}`,
    branch: job.branch,
  })),
  // The one-shot, no-checkout inline completion (requirements reviewer / brainstorm /
  // task-estimator / inline document kinds) on a leased subscription credential — the
  // container analogue of the local host-CLI inline runner. See inline.ts.
  inline: defineKind(parseInlineJob, handleInline, (job) => ({
    harness: job.harness,
    model: job.model,
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
      // Report the harness version so a backend can detect a stale/mismatched executor and
      // fail loudly early (see version.ts). Unauthenticated like the rest of /health — the
      // version is not a secret. An old image predating this field simply omits it, which the
      // backend treats as a stale signal.
      //
      // `docker` is this container's own verdict on its daemon (see docker-status.ts). It rides
      // /health because that is where an operator and a boot-time probe already look, and because
      // the alternative was every agent discovering an absent daemon for itself, one failed
      // compose command at a time. Reported, never enforced here: what REFUSES on it is the
      // stand-up in agent.ts, which is the only place that knows a job wanted a daemon.
      //
      // Deliberately the BOOT record, not a live probe. /health is polled, and a probe per poll
      // would spawn a process per poll to answer a question this endpoint is not the one to act
      // on; the stand-up re-confirms a recorded absence at the moment it matters
      // (`resolveDockerVerdict`), so a stale negative here never becomes a stale refusal there.
      //
      // `workload` is the other half, and the reason the block used to mislead: what the record
      // says is `serving`, and serving is not usable. It reports the last measurement any job
      // took (docker-capability.ts) and NEVER takes one itself, for the same polling reason,
      // which is why `unmeasured` is one of the words it can answer.
      return send(res, 200, {
        status: 'ok',
        ...(HARNESS_VERSION ? { version: HARNESS_VERSION } : {}),
        capabilities: HARNESS_BODY_CAPABILITIES,
        docker: { ...(await readDockerStatus()), workload: reportedDockerWorkload() },
      })
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
    // Stop one job: DELETE /jobs/{id}. The counterpart of the capability handshake below. A
    // backend that reads the acceptance and decides the body cannot be honoured has, by then,
    // already started an agent, and the only thing that keeps it from running to completion (and
    // opening a pull request for a step the engine has failed) is being told to stop.
    //
    // Scoped to ONE job on purpose: a pooled container serves other runs, so the shutdown-time
    // `abortAll` is not an alternative. The response reports the state the job actually REACHED
    // (the registry waits for it to settle), never merely that the signal was sent, because the
    // caller turns this into a statement to a human about whether anything is still running.
    if (req.method === 'DELETE' && req.url?.startsWith('/jobs/')) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length))
      // `abort` (not `get`) is the existence probe: `get` DRAINS the job's span / follow-up /
      // call-metric buffers, so probing with it would swallow telemetry the backend never polled.
      for (const { registry } of Object.values(KINDS)) {
        const state = await registry.abort(id, 'stopped by the backend')
        if (state) return send(res, 200, { jobId: id, state })
      }
      // No such job here. A 404 is NOT "already stopped": it is also what a caller addressing the
      // wrong runner sees, so it must stay distinguishable from the 200 above.
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
        // The capability handshake rides the ACCEPTANCE, not the poll view. The dispatch site
        // is the only place the body it just sent is still in scope, and it is the last moment
        // a blind run can be refused before the agent starts working from a prompt the body
        // cannot back up. It is also a static fact about the IMAGE, so repeating it on every
        // poll of a job that may run for an hour would be noise.
        return send(res, 202, {
          jobId: view.id,
          state: view.state,
          capabilities: HARNESS_BODY_CAPABILITIES,
        })
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

/**
 * What this process calls itself once it is running, and the second half of the naming defence
 * described in the header (the file name is the first).
 *
 * Setting it rewrites BOTH halves of what a pattern kill matches on Linux: `/proc/<pid>/cmdline`
 * becomes this string in full, and `/proc/<pid>/comm` its first 15 characters. So neither
 * `pkill -f 'node dist/…'` (cmdline) nor a bare `pkill node` (name) can name the harness, and a
 * hand-rolled `/proc` sweep for the agent's own service finds only that service.
 *
 * It is deliberately NOT a path: an agent looking for what it started searches for what it
 * started, and nothing an agent runs is called this.
 */
export const PROCESS_TITLE = 'cat-factory-harness'

// Only auto-listen when run as the entry point (tests import handleRun directly).
if (process.env.NODE_ENV !== 'test') {
  // Before `listen`, so no job can be accepted while this process still answers to `node`.
  process.title = PROCESS_TITLE
  server.listen(PORT, BIND_HOST, () => {
    console.log(`executor-harness listening on ${BIND_HOST ?? ''}:${PORT}`)
  })

  // Graceful shutdown: dying to a bare SIGTERM/SIGINT (the default handler) would ORPHAN any
  // in-flight `claude`/`codex`/git child — reparented, it keeps working unsupervised (and in
  // native local mode on the developer's own login). Abort every running job first (the
  // SIGTERM→SIGKILL escalation in killChildProcess), then exit as SOON as the aborted jobs have
  // settled — the CLI usually honours SIGTERM in milliseconds, so don't block every shutdown on
  // a fixed window. The 6s cap covers a job that ignored SIGTERM and had to be force-killed (the
  // 5s escalation) plus a margin. Nothing running ⇒ exit immediately. A second signal takes the
  // default (immediate) exit, since `once` leaves it unhandled.
  const shutdown = (signal: string): void => {
    const aborted = Object.values(KINDS).reduce(
      (count, { registry }) => count + registry.abortAll(`harness shutting down (${signal})`),
      0,
    )
    log.info('shutting down', { signal, abortedJobs: aborted })
    server.close()
    if (aborted === 0) {
      process.exit(0)
      return
    }
    const deadline = Date.now() + 6_000
    const timer = setInterval(() => {
      const stillRunning = Object.values(KINDS).some(({ registry }) => registry.runningCount() > 0)
      if (!stillRunning || Date.now() >= deadline) {
        clearInterval(timer)
        process.exit(0)
      }
    }, 50)
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

export { server }
