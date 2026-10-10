import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { standUpFrontend } from '../src/frontend-infra.js'
import { DEFAULT_HARNESS_PORT } from '../src/harness-port.js'
import { silentLogger, tempDir } from './helpers.js'

// The frontend stand-up's install/build are spawned by the HARNESS, not by the agent, so they do
// NOT inherit whatever env the agent's CLI child was handed. On the native path the job's npmrc
// lives under a per-job dir rather than the process's `~/.npmrc`, so without `RunOptions.agentEnv`
// reaching these spawns the install would silently lose the job's private-registry auth.
//
// Unix-only: the fake package manager is a chmod-+x shebang script (the same constraint
// agent-runner.test.ts carries).
const unix = process.platform !== 'win32'

describe.runIf(unix)('standUpFrontend job env', () => {
  let binDir: string
  let workDir: string
  let priorPath: string | undefined

  beforeEach(async () => {
    binDir = await tempDir('bin-')
    workDir = await tempDir('fe-')
    priorPath = process.env.PATH
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
    // A fake package manager that dumps its environment and then FAILS, so the stand-up aborts at
    // step 1 instead of going on to build/serve/health-check a frontend that doesn't exist.
    const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(process.cwd(), 'env.json'), JSON.stringify(process.env))
process.exit(1)
`
    await writeFile(join(binDir, 'fake-pm'), script, { mode: 0o755 })
  })

  afterEach(() => {
    process.env.PATH = priorPath
  })

  it("hands the job's env to the install it spawns", async () => {
    const stood = await standUpFrontend(
      workDir,
      { kind: 'frontend', install: 'fake-pm install' },
      { agentEnv: { npm_config_userconfig: '/tmp/job/.npmrc' } },
      silentLogger,
    )

    const env = JSON.parse(await readFile(join(workDir, 'env.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(env.npm_config_userconfig).toBe('/tmp/job/.npmrc')
    // The install failing is what keeps this test cheap; the stand-up reports it rather than throwing.
    expect(stood.record?.started).toBe(false)
  })

  it('inherits the process env when the job carries none', async () => {
    await standUpFrontend(
      workDir,
      { kind: 'frontend', install: 'fake-pm install' },
      {},
      silentLogger,
    )

    const env = JSON.parse(await readFile(join(workDir, 'env.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(env.PATH).toContain(binDir)
    expect(env.npm_config_userconfig).toBeUndefined()
  })
})

// The serve port the harness REFUSES: its own. The contracts-side guard reserves the default
// harness port, which is a prediction rather than an observation, so a deployment that sets `PORT`
// (a Kubernetes runner pool carries its own `harnessPort`) can hand the stand-up a serve port the
// guard never reserved. A collision is the wrong-answer case, not merely a bind failure: the serve
// dies with EADDRINUSE and the health check is then answered by the harness.
describe('standUpFrontend serve-port collision', () => {
  const restore = { ...process.env }
  afterEach(() => {
    process.env = { ...restore }
  })

  it('refuses when the serve port is the port this harness holds', async () => {
    delete process.env.PORT
    const workDir = await tempDir('fe-collide-')
    const stood = await standUpFrontend(
      workDir,
      { kind: 'frontend', servePort: DEFAULT_HARNESS_PORT },
      {},
      silentLogger,
    )
    expect(stood.serveUrl).toBeUndefined()
    expect(stood.record?.started).toBe(false)
    expect(stood.note).toContain(String(DEFAULT_HARNESS_PORT))
    expect(stood.note).toContain('harness is listening on')
  })

  it('reads the port this process HOLDS, not the default the contracts guard reserves', async () => {
    // The case the contracts guard structurally cannot make: `PORT` moved the harness somewhere
    // the shared constant does not name, so only a check here can see the collision.
    process.env.PORT = '41234'
    const workDir = await tempDir('fe-collide-env-')
    const stood = await standUpFrontend(
      workDir,
      { kind: 'frontend', servePort: 41234 },
      {},
      silentLogger,
    )
    expect(stood.record?.started).toBe(false)
    expect(stood.note).toContain('41234')
    expect(stood.note).toContain('harness is listening on')
  })
})
