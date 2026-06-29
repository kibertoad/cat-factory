import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyLocalDefaults } from '../src/config.js'

// Local mode auto-generates AUTH_SESSION_SECRET when unset; it must be STABLE across restarts
// (otherwise every restart invalidates the persisted session JWT and forces a re-login). The
// secret is persisted to CAT_FACTORY_STATE_DIR (defaulting to ~/.cat-factory); these tests
// point it at a temp dir so they touch no real home dir.

describe('[local] applyLocalDefaults session secret', () => {
  let stateDir: string
  const original = process.env.CAT_FACTORY_STATE_DIR

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cat-factory-state-'))
    process.env.CAT_FACTORY_STATE_DIR = stateDir
  })

  afterEach(() => {
    if (original === undefined) delete process.env.CAT_FACTORY_STATE_DIR
    else process.env.CAT_FACTORY_STATE_DIR = original
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('generates a stable secret across calls and persists it to a file', () => {
    const first = applyLocalDefaults({}).AUTH_SESSION_SECRET
    const second = applyLocalDefaults({}).AUTH_SESSION_SECRET

    expect(first).toBeTruthy()
    // Same value within a process (the file is read back on the second call)...
    expect(second).toBe(first)
    // ...and persisted, so a later "restart" reading the same dir recovers it.
    expect(readFileSync(join(stateDir, 'session-secret'), 'utf8').trim()).toBe(first)
  })

  it('lets an explicit AUTH_SESSION_SECRET win over the persisted file', () => {
    const env = applyLocalDefaults({ AUTH_SESSION_SECRET: 'explicit-secret' })
    expect(env.AUTH_SESSION_SECRET).toBe('explicit-secret')
  })
})
