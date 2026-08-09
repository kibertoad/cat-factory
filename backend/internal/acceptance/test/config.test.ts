import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

// The refusal is the thing worth testing here. Everything else in this package needs a live
// deployment; this is the one part whose whole job is to happen BEFORE there is one, and the
// property it exists for (reporting every problem at once) is exactly what a well-meaning
// refactor to "throw on the first missing variable" would take away without failing anything else.

const COMPLETE = {
  CAT_FACTORY_BASE_URL: 'http://127.0.0.1:8787',
  CAT_FACTORY_API_KEY: 'cf_live_pak_test.secret',
  ACCEPTANCE_WORKSPACE_ID: 'ws_1',
  ACCEPTANCE_REPO_OWNER: 'acme',
  ACCEPTANCE_K3S_API_SERVER: 'https://127.0.0.1:6443',
  ACCEPTANCE_K3S_TOKEN: 'sa-token',
  ACCEPTANCE_K3S_INSECURE: 'true',
} as const

function expectOk(env: Record<string, string | undefined>) {
  const resolution = resolveConfig(env)
  if (!resolution.ok) throw new Error(`expected a config, got: ${resolution.problems.join('; ')}`)
  return resolution.config
}

function expectProblems(env: Record<string, string | undefined>) {
  const resolution = resolveConfig(env)
  if (resolution.ok) throw new Error('expected a refusal, got a config')
  return resolution.problems
}

describe('resolveConfig', () => {
  it('resolves a complete environment', () => {
    const config = expectOk(COMPLETE)
    expect(config.baseUrl).toBe('http://127.0.0.1:8787')
    expect(config.workspaceId).toBe('ws_1')
    expect(config.cluster.insecureSkipTlsVerify).toBe(true)
  })

  it('reports EVERY missing variable at once, not just the first', () => {
    const problems = expectProblems({ ACCEPTANCE_K3S_INSECURE: 'true' })
    // Derived from the same list the resolver reads rather than pinned to a count: a new required
    // variable should not need this assertion edited, and a count would say nothing about which
    // one went missing.
    for (const name of Object.keys(COMPLETE).filter((key) => key !== 'ACCEPTANCE_K3S_INSECURE')) {
      expect(problems.some((problem) => problem.startsWith(name))).toBe(true)
    }
  })

  it('names what each missing variable is for', () => {
    const problems = expectProblems({})
    const apiKey = problems.find((problem) => problem.startsWith('CAT_FACTORY_API_KEY'))
    // The purpose is the half that makes the message actionable; a bare "X is required" sends
    // someone to the README for every name in the list.
    expect(apiKey).toContain('admin')
  })

  it('refuses a cluster with neither a CA nor an explicit insecure opt-in', () => {
    const { ACCEPTANCE_K3S_INSECURE: _omitted, ...withoutTls } = COMPLETE
    const problems = expectProblems(withoutTls)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('ACCEPTANCE_K3S_CA_PEM')
  })

  it('prefers a supplied CA over the insecure flag, so a pasted CA is never silently downgraded', () => {
    const config = expectOk({ ...COMPLETE, ACCEPTANCE_K3S_CA_PEM: '-----BEGIN CERTIFICATE-----' })
    expect(config.cluster.caCertPem).toBe('-----BEGIN CERTIFICATE-----')
  })

  it('treats a whitespace-only value as absent', () => {
    // A `.env` line like `ACCEPTANCE_WORKSPACE_ID= ` otherwise resolves to a workspace id of one
    // space, which reaches the deployment and 404s on everything.
    const problems = expectProblems({ ...COMPLETE, ACCEPTANCE_WORKSPACE_ID: '   ' })
    expect(problems[0]).toContain('ACCEPTANCE_WORKSPACE_ID')
  })

  it('strips a trailing slash from the base URL so paths never double up', () => {
    const config = expectOk({ ...COMPLETE, CAT_FACTORY_BASE_URL: 'http://127.0.0.1:8787/' })
    expect(config.baseUrl).toBe('http://127.0.0.1:8787')
  })

  it('refuses a non-numeric run budget rather than silently using the default', () => {
    const problems = expectProblems({ ...COMPLETE, ACCEPTANCE_RUN_BUDGET_MS: 'ninety minutes' })
    expect(problems[0]).toContain('ACCEPTANCE_RUN_BUDGET_MS')
  })

  it('applies the defaults an operator does not have to think about', () => {
    const config = expectOk(COMPLETE)
    expect(config.namePrefix).toBe('cf-acc')
    expect(config.stateDir).toBe('.acceptance')
    expect(config.runBudgetMs).toBe(90 * 60 * 1000)
    // nip.io resolves `<anything>.127.0.0.1` to loopback, so the default template needs no DNS.
    expect(config.cluster.ingressHostTemplate).toContain('127.0.0.1.nip.io')
  })
})
