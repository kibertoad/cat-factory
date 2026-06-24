import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import {
  buildImage,
  committingLlmStub,
  dockerAvailable,
  freePort,
  githubStub,
  listen,
  reclaimMount,
  removeContainer,
  seedBareRepo,
  startContainer,
  todoDrivingLlmStub,
  waitForHealth,
} from './support'

// Full-blown acceptance test: it builds and launches the real Docker image and
// drives a complete `POST /run` — clone → Pi implements → commit → push → open
// PR — with the LLM served by a **dummy adapter** that returns hardcoded
// streaming responses (no real provider, no real GitHub). It asserts the file
// landed on a pushed branch and that the PR was opened.
//
// The repo is a bind-mounted local bare repo (cloned via file://), and the LLM
// proxy + GitHub API are local stub servers the container reaches over
// host.docker.internal. Self-skips when no Docker daemon is available.

const docker = dockerAvailable()

describe.skipIf(!docker)('executor container acceptance', () => {
  let work: string
  let bare: string

  beforeAll(() => {
    buildImage()
    ;({ work, bare } = seedBareRepo())
  })

  afterAll(() => {
    if (!work) return
    reclaimMount(work)
    rmSync(work, { recursive: true, force: true })
  })

  const containers: string[] = []
  afterEach(() => {
    for (const name of containers.splice(0)) removeContainer(name)
  })

  it('clones, runs Pi, pushes a branch and opens a PR', async () => {
    const proxy = committingLlmStub()
    const github = githubStub()
    const proxyPort = await listen(proxy.server)
    const ghPort = await listen(github.server)
    const hostPort = await freePort()
    const name = `cf-acc-${Date.now()}`
    containers.push(name)
    startContainer(name, hostPort, bare)
    await waitForHealth(hostPort)

    const job = {
      kind: 'run',
      jobId: 'acc-1',
      systemPrompt: 'You are a builder. Create exactly the file the user asks for.',
      userPrompt: 'Create IMPLEMENTED.md containing "hello from pi".',
      model: 'dummy-model',
      proxyBaseUrl: `http://host.docker.internal:${proxyPort}/v1`,
      sessionToken: 'dummy-session-token',
      ghToken: 'dummy-gh-token',
      repo: { owner: 'octo', name: 'app', baseBranch: 'main', cloneUrl: 'file:///srv/repo' },
      headBranch: 'cat-factory/acc-1',
      pr: { title: 'Add IMPLEMENTED.md', body: 'Automated by acceptance test' },
      githubApiBase: `http://host.docker.internal:${ghPort}`,
    }

    let result: { prUrl?: string; branch?: string; summary?: string; error?: string }
    try {
      // Start the async job, then poll until it reaches a terminal state.
      const start = await fetch(`http://127.0.0.1:${hostPort}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      })
      expect(start.status).toBe(202)
      expect(((await start.json()) as { jobId: string }).jobId).toBe('acc-1')

      const deadline = Date.now() + 180_000
      let view: { state: string; result?: typeof result; error?: string }
      do {
        await new Promise((r) => setTimeout(r, 1000))
        const poll = await fetch(`http://127.0.0.1:${hostPort}/jobs/acc-1`)
        expect(poll.status).toBe(200)
        view = (await poll.json()) as typeof view
      } while (view.state === 'running' && Date.now() < deadline)

      expect(view.state).toBe('done')
      result = view.result ?? { error: view.error }
    } finally {
      proxy.server.close()
      github.server.close()
    }

    // --- The run succeeded and returned the stub PR url + Pi's summary. -------
    expect(result.error).toBeUndefined()
    expect(result.prUrl).toBe('http://gh.test/octo/app/pull/1')
    expect(result.branch).toBe('cat-factory/acc-1')
    expect(result.summary).toContain('Created IMPLEMENTED.md')

    // --- Pi actually talked to the dummy proxy (with the session token). ------
    expect(proxy.requests.length).toBeGreaterThanOrEqual(2)
    expect(proxy.requests[0]!.model).toBe('dummy-model')
    expect(proxy.requests[0]!.hasTools).toBe(true)
    expect(proxy.requests[0]!.auth).toBe('Bearer dummy-session-token')

    // --- The PR was opened against the stub with the right head/base. ---------
    expect(github.pulls).toHaveLength(1)
    expect(github.pulls[0]!.body).toMatchObject({
      head: 'cat-factory/acc-1',
      base: 'main',
      title: 'Add IMPLEMENTED.md',
    })
    expect(github.pulls[0]!.auth).toBe('Bearer dummy-gh-token')

    // --- The branch was pushed to the repo with the new file committed. -------
    const branchSha = execFileSync('git', [
      '-C',
      bare,
      'rev-parse',
      '--verify',
      'cat-factory/acc-1',
    ])
      .toString()
      .trim()
    expect(branchSha).toMatch(/^[0-9a-f]{40}$/)
    const fileContent = execFileSync('git', [
      '-C',
      bare,
      'show',
      'cat-factory/acc-1:IMPLEMENTED.md',
    ]).toString()
    expect(fileContent).toContain('hello from pi')
  })

  it('drives the todo tool and reports subtask progress', async () => {
    // This proves the installed rpiv-todo extension actually loads and emits
    // structured `todo` tool results that the harness parses into progress — the
    // dummy-proxy happy-path test never touches the tool.
    const proxy = todoDrivingLlmStub()
    const github = githubStub()
    const proxyPort = await listen(proxy.server)
    const ghPort = await listen(github.server)
    const hostPort = await freePort()
    const name = `cf-acc-todo-${Date.now()}`
    containers.push(name)
    startContainer(name, hostPort, bare)
    await waitForHealth(hostPort)

    const job = {
      kind: 'run',
      jobId: 'acc-todo',
      systemPrompt: 'You are a builder. Plan with the todo tool, then create the file.',
      userPrompt: 'Create IMPLEMENTED.md containing "hello from pi".',
      model: 'dummy-model',
      proxyBaseUrl: `http://host.docker.internal:${proxyPort}/v1`,
      sessionToken: 'dummy-session-token',
      ghToken: 'dummy-gh-token',
      repo: { owner: 'octo', name: 'app', baseBranch: 'main', cloneUrl: 'file:///srv/repo' },
      headBranch: 'cat-factory/acc-todo',
      pr: { title: 'Add IMPLEMENTED.md', body: 'Automated by acceptance test' },
      githubApiBase: `http://host.docker.internal:${ghPort}`,
    }

    interface ProgressView {
      state: string
      progress?: { completed: number; inProgress: number; total: number }
      result?: { prUrl?: string; error?: string }
      error?: string
    }

    let view: ProgressView
    // Capture the last non-empty progress snapshot seen across polls so the
    // assertion holds whether or not the terminal view still carries it.
    let lastProgress: ProgressView['progress']
    try {
      const start = await fetch(`http://127.0.0.1:${hostPort}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      })
      expect(start.status).toBe(202)

      const deadline = Date.now() + 180_000
      do {
        await new Promise((r) => setTimeout(r, 1000))
        const poll = await fetch(`http://127.0.0.1:${hostPort}/jobs/acc-todo`)
        expect(poll.status).toBe(200)
        view = (await poll.json()) as ProgressView
        if (view.progress) lastProgress = view.progress
      } while (view.state === 'running' && Date.now() < deadline)
    } finally {
      proxy.server.close()
      github.server.close()
    }

    // The run completed and the model worked through the whole scripted plan.
    expect(view.state).toBe('done')
    expect(view.result?.error).toBeUndefined()
    expect(view.result?.prUrl).toBe('http://gh.test/octo/app/pull/1')

    // Two of three subtasks completed, the third left in-progress — exactly what
    // the rpiv-todo `tool_result` events encode, parsed by the harness.
    expect(lastProgress).toMatchObject({ completed: 2, inProgress: 1, total: 3 })
  })
})

if (!docker) {
  console.warn('[acceptance] Docker not available — skipping container acceptance tests')
}
