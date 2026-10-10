import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentChildEnv, HARNESS_ONLY_ENV_NAMES } from '../src/agent-env.js'
import { DEFAULT_HARNESS_PORT } from '../src/harness-port.js'
import { runCapturedCommand } from '../src/captured-command.js'
import { silentLogger } from './helpers.js'

// The env the harness hands to anything it runs in the agent's CHECKOUT. The rule under test is
// narrow and each member of it was a real defect: the harness's own `NODE_ENV=production` must not
// be inherited there, because npm reads it as `omit=dev` and an agent's `npm install` then silently
// skips every devDependency; its `PORT` must not be either, because the harness holds that port in
// the job container's one network namespace, so a service that reads `process.env.PORT` binds the
// address already taken and a `$PORT` health check grades the harness in its place.

describe('agentChildEnv', () => {
  const restore = { ...process.env }
  afterEach(() => {
    process.env = { ...restore }
  })

  it('drops the harness-only variables from the inherited env', () => {
    process.env.NODE_ENV = 'production'
    expect(agentChildEnv()).not.toHaveProperty('NODE_ENV')
  })

  it('keeps everything else the harness process carries', () => {
    process.env.NODE_ENV = 'production'
    process.env.CF_TEST_CARRIED = 'kept'
    expect(agentChildEnv().CF_TEST_CARRIED).toBe('kept')
  })

  it('lets a layer set a stripped name back — the strip removes what was only inherited', () => {
    process.env.NODE_ENV = 'production'
    expect(agentChildEnv({ NODE_ENV: 'test' }).NODE_ENV).toBe('test')
  })

  it('applies layers in order, last wins', () => {
    expect(agentChildEnv({ A: '1', B: '1' }, { B: '2' })).toMatchObject({ A: '1', B: '2' })
  })

  it('never mutates the harness process env (one native host process serves every job)', () => {
    process.env.NODE_ENV = 'production'
    const child = agentChildEnv({ CF_TEST_JOB: 'x' })
    expect(child.CF_TEST_JOB).toBe('x')
    expect(process.env.NODE_ENV).toBe('production')
    expect(process.env.CF_TEST_JOB).toBeUndefined()
  })

  it('names NODE_ENV as a variable the checkout must not inherit', () => {
    expect(HARNESS_ONLY_ENV_NAMES).toContain('NODE_ENV')
  })

  it('names PORT too: the harness holds it, so an inherited one aims at a taken address', () => {
    // Moving the job server off 8080 stops the agent's service losing the port it ASKED for.
    // Inheriting `PORT` would hand it the new number instead, which relocates the collision
    // rather than closing it: the service dies with EADDRINUSE and a `$PORT` health check reads
    // the harness's own `{"status":"ok"}` as the product's.
    process.env.PORT = String(DEFAULT_HARNESS_PORT)
    expect(HARNESS_ONLY_ENV_NAMES).toContain('PORT')
    expect(agentChildEnv()).not.toHaveProperty('PORT')
  })

  it('lets the frontend serve set PORT back: that layer IS the port the health check polls', () => {
    // `startServe` passes the resolved serve port as an explicit layer, and the strip must not
    // turn that into a spawn with no PORT at all.
    process.env.PORT = String(DEFAULT_HARNESS_PORT)
    expect(agentChildEnv({ PORT: '4173' }).PORT).toBe('4173')
  })
})

describe('a command the harness runs in the checkout', () => {
  const restore = { ...process.env }
  afterEach(() => {
    process.env = { ...restore }
  })

  // The behavioural half: asserting the helper alone would keep passing if a spawn seam went back
  // to spreading `process.env` directly. This drives the real runner the dependency install and
  // the validation checks both go through.
  it('sees no inherited NODE_ENV or PORT', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PORT = String(DEFAULT_HARNESS_PORT)
    const cwd = await mkdtemp(join(tmpdir(), 'cf-agent-env-'))
    const result = await runCapturedCommand({
      cwd,
      command: 'echo "NODE_ENV=[${NODE_ENV:-unset}] PORT=[${PORT:-unset}]"',
      timeoutMs: 30_000,
      reportTailChars: 500,
      logLabel: 'test',
      logger: silentLogger,
      opts: {},
    })
    expect(result.exitCode).toBe(0)
    expect(result.outputTail).toContain('NODE_ENV=[unset]')
    expect(result.outputTail).toContain('PORT=[unset]')
  })
})
