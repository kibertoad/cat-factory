import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registeredAgentKind,
  registeredAgentStep,
  registeredKindRequiresContainer,
  registeredPostOps,
} from '@cat-factory/agents'
import type { RepoFiles } from '@cat-factory/kernel'
import { clearRegisteredPipelines, seedPipelines } from '@cat-factory/kernel'
import {
  EXAMPLE_AGENT_KINDS,
  ORG_AUDIT_PIPELINE_ID,
  ORG_REVIEWER_KIND,
  SECURITY_AUDITOR_KIND,
  registerExampleCustomAgents,
  renderComplianceReport,
} from './index.js'

// The package self-registers on import (side effect), but tests clear the global registry
// for isolation — so register fresh before each test and clean up after.
beforeEach(() => {
  clearRegisteredAgentKinds()
  clearRegisteredPipelines()
  registerExampleCustomAgents()
})
afterEach(() => {
  clearRegisteredAgentKinds()
  clearRegisteredPipelines()
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
    for (const def of EXAMPLE_AGENT_KINDS) {
      expect(def.presentation?.label).toBeTruthy()
      expect(def.presentation?.category).toBe('review')
    }
    // The auditor opens the shared generic structured viewer.
    expect(registeredAgentKind(SECURITY_AUDITOR_KIND)?.presentation?.resultView).toBe(
      'generic-structured',
    )
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
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
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
    const input = commitFiles.mock.calls[0]![0]
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
