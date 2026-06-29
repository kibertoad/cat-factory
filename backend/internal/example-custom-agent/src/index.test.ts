import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registeredAgentKind,
  registeredAgentStep,
  registeredKindRequiresContainer,
  registeredPostOps,
} from '@cat-factory/agents'
import type { CommitFilesInput, GateStepState, RepoFiles } from '@cat-factory/kernel'
import {
  clearRegisteredGates,
  clearRegisteredPipelines,
  clearRegisteredStepResolvers,
  registeredGateFactories,
  registeredStepResolverFactories,
  seedPipelines,
  stubGateContext,
  stubResolverContext,
} from '@cat-factory/kernel'
import {
  EXAMPLE_AGENT_KINDS,
  LICENSE_CHECK_KIND,
  LICENSE_FIXER_KIND,
  ORG_AUDIT_PIPELINE_ID,
  ORG_REVIEWER_KIND,
  SECURITY_AUDITOR_KIND,
  registerExampleCustomAgents,
  renderComplianceReport,
  wireLicenseProvider,
} from './index.js'

// The package self-registers on import (side effect), but tests clear the global registries
// for isolation — so register fresh before each test and clean up after.
beforeEach(() => {
  clearRegisteredAgentKinds()
  clearRegisteredPipelines()
  clearRegisteredGates()
  clearRegisteredStepResolvers()
  registerExampleCustomAgents()
})
afterEach(() => {
  clearRegisteredAgentKinds()
  clearRegisteredPipelines()
  clearRegisteredGates()
  clearRegisteredStepResolvers()
  // The license provider is a module-level handle; clear it so a wired test can't leak.
  wireLicenseProvider(undefined)
})

describe('example custom agents', () => {
  it('registers both kinds with the right surfaces', () => {
    expect(registeredAgentKind(ORG_REVIEWER_KIND)).toBeTruthy()
    expect(registeredAgentStep(ORG_REVIEWER_KIND)?.surface).toBe('inline')
    expect(registeredKindRequiresContainer(ORG_REVIEWER_KIND)).toBe(false)

    expect(registeredAgentStep(SECURITY_AUDITOR_KIND)?.surface).toBe('container-explore')
    expect(registeredAgentStep(SECURITY_AUDITOR_KIND)?.output?.kind).toBe('structured')
    // A container surface implies the container requirement without `requiresContainer`.
    expect(registeredKindRequiresContainer(SECURITY_AUDITOR_KIND)).toBe(true)
  })

  it('exposes presentation so the kinds become first-class palette blocks', () => {
    const validCategories = new Set(['review', 'design', 'build', 'test', 'docs', 'gates'])
    for (const def of EXAMPLE_AGENT_KINDS) {
      expect(def.presentation?.label).toBeTruthy()
      expect(validCategories.has(def.presentation?.category ?? '')).toBe(true)
    }
    // The two reviewers are review blocks; the license-fixer helper is a build block.
    expect(registeredAgentKind(ORG_REVIEWER_KIND)?.presentation?.category).toBe('review')
    expect(registeredAgentKind(SECURITY_AUDITOR_KIND)?.presentation?.category).toBe('review')
    expect(registeredAgentKind(LICENSE_FIXER_KIND)?.presentation?.category).toBe('build')
    // The auditor opens the shared generic structured viewer.
    expect(registeredAgentKind(SECURITY_AUDITOR_KIND)?.presentation?.resultView).toBe(
      'generic-structured',
    )
  })

  it('registers the license-check gate, escalating to the license-fixer helper kind', () => {
    const registered = registeredGateFactories()
    expect(registered.map((g) => g.kind)).toContain(LICENSE_CHECK_KIND)
    // The helper is itself a registered agent kind (a container-coding fixer).
    expect(registeredAgentStep(LICENSE_FIXER_KIND)?.surface).toBe('container-coding')

    // Build the gate with a throwaway context; without a wired provider it passes through.
    const gate = registered.find((g) => g.kind === LICENSE_CHECK_KIND)!.factory(stubGateContext())
    expect(gate.helperKind).toBe(LICENSE_FIXER_KIND)
    // Unwired ⇒ a harmless pass-through, so a bare import is always safe.
    expect(gate.wired()).toBe(false)
  })

  it('arms the gate via wireLicenseProvider: probe maps a clean/dirty report to pass/fail', async () => {
    // Exercise the example's REAL wired()/probe() path (the licenseProvider deref) — the
    // engine-drive conformance tests inject verdicts through a test-local factory, so this
    // is the only coverage of the seam a deployment actually copies.
    const check = vi.fn(async () => ({ clean: true, headSha: 'sha-1', summary: 'all good' }))
    wireLicenseProvider({ check })
    const gate = registeredGateFactories()
      .find((g) => g.kind === LICENSE_CHECK_KIND)!
      .factory(stubGateContext())

    // Wired now ⇒ the gate runs its probe instead of passing through.
    const stubState: GateStepState = { phase: 'checking', attempts: 0, maxAttempts: 10 }
    expect(gate.wired()).toBe(true)
    const pass = await gate.probe('ws', 'blk_1', stubState)
    expect(check).toHaveBeenCalledWith('ws', 'blk_1')
    expect(pass.status).toBe('pass')
    expect(pass.headSha).toBe('sha-1')

    // A dirty report ⇒ a fail verdict the engine escalates to the license-fixer.
    check.mockResolvedValueOnce({ clean: false, headSha: 'sha-2', summary: 'src/a.ts missing' })
    const fail = await gate.probe('ws', 'blk_1', stubState)
    expect(fail.status).toBe('fail')
    expect(fail.failureSummary).toContain('missing')
  })

  it('registers a step resolver that summarises the security auditor’s output', async () => {
    const registered = registeredStepResolverFactories()
    expect(registered.map((r) => r.kind)).toContain(SECURITY_AUDITOR_KIND)
    const resolver = registered
      .find((r) => r.kind === SECURITY_AUDITOR_KIND)!
      .factory(stubResolverContext())
    const resolution = await resolver.resolve({
      workspaceId: 'ws',
      instance: { id: 'exec' } as never,
      step: {} as never,
      result: { output: 'done', custom: { risk: 0.2, findings: [{ title: 'a' }, { title: 'b' }] } },
      isFinalStep: true,
    })
    expect(resolution?.output).toContain('2 finding(s)')
    expect(resolution?.output).toContain('20%')
  })

  it('appends the pl_org_audit pipeline chaining the two kinds', () => {
    const pipeline = seedPipelines().find((p) => p.id === ORG_AUDIT_PIPELINE_ID)
    expect(pipeline?.agentKinds).toEqual([ORG_REVIEWER_KIND, SECURITY_AUDITOR_KIND])
  })

  it('renders a deterministic compliance report from the assessment', () => {
    const md = renderComplianceReport({
      risk: 0.4,
      summary: 'Mostly safe.',
      findings: [
        { title: 'Unvalidated input', detail: 'Sanitise the path param.', severity: 'high' },
      ],
    })
    expect(md).toContain('# Security compliance report')
    expect(md).toContain('**Overall risk:** 40%')
    expect(md).toContain('Mostly safe.')
    expect(md).toContain('**Unvalidated input** _(high)_')
    // Pure: same input → identical bytes.
    expect(
      renderComplianceReport({
        risk: 0.4,
        summary: 'Mostly safe.',
        findings: [
          { title: 'Unvalidated input', detail: 'Sanitise the path param.', severity: 'high' },
        ],
      }),
    ).toBe(md)
  })

  it('post-op commits the rendered report onto the run branch via RepoFiles', async () => {
    const commitFiles = vi.fn<(input: CommitFilesInput) => Promise<{ sha: string }>>(async () => ({ sha: 'sha' }))
    // No report on the branch yet (getFile → null), so the idempotency guard lets the commit through.
    const getFile = vi.fn(async () => null)
    const repo = { getFile, commitFiles } as unknown as RepoFiles
    const [postOp] = registeredPostOps(SECURITY_AUDITOR_KIND)
    expect(postOp).toBeTruthy()

    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      context: { agentKind: SECURITY_AUDITOR_KIND } as never,
      result: { output: 'done', custom: { risk: 0.1, summary: 'Clean', findings: [] } },
    })

    expect(commitFiles).toHaveBeenCalledTimes(1)
    const input = commitFiles.mock.calls[0]![0]!
    expect(input.branch).toBe('cat-factory/blk_1')
    expect(input.files[0]!.path).toBe('compliance/REPORT.md')
    expect(input.files[0]!.content).toContain('# Security compliance report')
  })

  it('post-op is idempotent: skips the commit when the report on the branch is unchanged', async () => {
    const [postOp] = registeredPostOps(SECURITY_AUDITOR_KIND)
    const assessment = { risk: 0.1, summary: 'Clean', findings: [] }
    // The branch already holds the byte-identical render the post-op would produce.
    const existing = renderComplianceReport(assessment)
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
    const getFile = vi.fn(async () => ({ content: existing, sha: 'blob-sha' }))
    const repo = { getFile, commitFiles } as unknown as RepoFiles
    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      context: { agentKind: SECURITY_AUDITOR_KIND } as never,
      result: { output: 'done', custom: assessment },
    })
    // No duplicate commit on a replay that re-runs the post-op after the prior one landed.
    expect(commitFiles).not.toHaveBeenCalled()
  })

  it('post-op is a no-op when the agent returned nothing parseable', async () => {
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
    const repo = { commitFiles } as unknown as RepoFiles
    const [postOp] = registeredPostOps(SECURITY_AUDITOR_KIND)
    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      context: { agentKind: SECURITY_AUDITOR_KIND } as never,
      result: { output: 'no json' },
    })
    expect(commitFiles).not.toHaveBeenCalled()
  })
})
