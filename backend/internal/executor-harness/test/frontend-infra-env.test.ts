import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { standUpFrontend } from '../src/frontend-infra.js'
import { tempDir } from './helpers.js'

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
    await standUpFrontend(workDir, { kind: 'frontend', install: 'fake-pm install' }, {})

    const env = JSON.parse(await readFile(join(workDir, 'env.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(env.PATH).toContain(binDir)
    expect(env.npm_config_userconfig).toBeUndefined()
  })
})
