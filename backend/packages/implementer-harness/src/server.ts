import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Job, parseJob, type RunResult } from './job.js'
import { cloneRepo, commitAll, createBranch, openPullRequest, pushBranch } from './git.js'
import { runPi, writeAgentsContext, writePiModelsConfig } from './pi.js'

// The container's HTTP entry point. The Worker addresses one instance per run and
// POSTs a job to /run; this orchestrates: clone → Pi implements → commit → push
// → open PR, and returns the PR url. Nothing here holds long-lived secrets — the
// per-job GitHub + proxy tokens arrive in the request body and live only for the
// duration of the job in an ephemeral workspace.

const PORT = Number(process.env.PORT ?? 8080)

/** Run one implementation job end to end. */
export async function handleRun(job: Job): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'impl-'))
  try {
    await cloneRepo({ repo: job.repo, ghToken: job.ghToken, dir })
    await createBranch(dir, job.headBranch)
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    const summary = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.userPrompt,
      sessionToken: job.sessionToken,
    })

    const committed = await commitAll(dir, job.pr.title)
    if (!committed) {
      return { summary, branch: job.headBranch, error: 'Pi produced no file changes' }
    }
    await pushBranch(dir, job.headBranch)
    const prUrl = await openPullRequest({
      owner: job.repo.owner,
      name: job.repo.name,
      ghToken: job.ghToken,
      head: job.headBranch,
      base: job.repo.baseBranch,
      pr: job.pr,
    })
    return { prUrl, branch: job.headBranch, summary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
    if (req.method !== 'POST' || req.url !== '/run') {
      return send(res, 404, { error: 'not found' })
    }
    try {
      const job = parseJob(JSON.parse(await readBody(req)))
      const result = await handleRun(job)
      // Job-level failures are returned as 200 + { error } so the Worker can read
      // the structured reason; unexpected faults fall through to 500 below.
      return send(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return send(res, 500, { error: message } satisfies RunResult)
    }
  })()
})

// Only auto-listen when run as the entry point (tests import handleRun directly).
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`implementer-harness listening on :${PORT}`)
  })
}

export { server }
