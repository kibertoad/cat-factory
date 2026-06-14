import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import {
  buildImage,
  dockerAvailable,
  freePort,
  githubStub,
  listen,
  reclaimMount,
  removeContainer,
  seedBareRepo,
  startContainer,
  streamingLlmStub,
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

describe.skipIf(!docker)('implementer container acceptance', () => {
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
    const proxy = streamingLlmStub()
    const github = githubStub()
    const proxyPort = await listen(proxy.server)
    const ghPort = await listen(github.server)
    const hostPort = await freePort()
    const name = `cf-acc-${Date.now()}`
    containers.push(name)
    startContainer(name, hostPort, bare)
    await waitForHealth(hostPort)

    const job = {
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

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 180_000)
    let result: { prUrl?: string; branch?: string; summary?: string; error?: string }
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
        signal: ac.signal,
      })
      expect(res.status).toBe(200)
      result = (await res.json()) as typeof result
    } finally {
      clearTimeout(timer)
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
})

if (!docker) {
  console.warn('[acceptance] Docker not available — skipping container acceptance tests')
}
