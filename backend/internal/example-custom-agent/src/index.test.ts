import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentKindRegistry, defaultAgentKindRegistry } from '@cat-factory/agents'
import type {
  CommitFilesInput,
  GateRegistry,
  GateStepState,
  JudgeRegistry,
  PipelineRegistry,
  PromptFragmentRegistry,
  ProviderRegistry,
  RepoFiles,
  StepResolverRegistry,
  TaskTypeRegistry,
} from '@cat-factory/kernel'
import { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
import {
  InitiativePresetRegistry,
  defaultGateRegistry,
  defaultJudgeRegistry,
  defaultPipelineRegistry,
  defaultTaskTypeRegistry,
  stubJudgeContext,
  defaultProviderRegistry,
  defaultStepResolverRegistry,
  describeCustomTaskType,
  noopLogger,
  sanitizeDescriptorFields,
  seedPipelines,
  stubGateContext,
  stubResolverContext,
  validateDescriptorFields,
} from '@cat-factory/kernel'
import {
  EXAMPLE_AGENT_KINDS,
  LICENSE_CHECK_KIND,
  LICENSE_FIXER_KIND,
  ORG_APPLY_PIPELINE_ID,
  ORG_AUDIT_PIPELINE_ID,
  ORG_AUDIT_PRESET,
  ORG_AUDIT_PRESET_ID,
  ORG_RESEARCH_KIND,
  ORG_RESEARCH_PIPELINE_ID,
  ORG_RESEARCH_PRESET,
  ORG_RESEARCH_PRESET_ID,
  ORG_REVIEWER_KIND,
  SECURITY_AUDITOR_KIND,
  registerExampleCustomAgents,
  renderComplianceReport,
  renderResearchReport,
  wireLicenseProvider,
  ORG_SCOPE_PIPELINE_ID,
  SCOPE_JUDGE_KIND,
  SCOPE_RUBRIC_FRAGMENT_ID,
  INTRODUCE_API_FRAGMENT_IDS,
  INTRODUCE_API_PIPELINE_ID,
  INTRODUCE_API_TASK_TYPE,
  ORG_ARCHITECT_API_VARIANT_ID,
  ORG_CODER_API_VARIANT_ID,
} from './index.js'

// Agent kinds + initiative presets + gates + step resolvers + pipelines live on app-owned
// registries — a fresh instance per test, no module global to clear.
let registry: AgentKindRegistry
let initiativePresetRegistry: InitiativePresetRegistry
let gateRegistry: GateRegistry
let stepResolverRegistry: StepResolverRegistry
let providerRegistry: ProviderRegistry
let pipelineRegistry: PipelineRegistry
let judgeRegistry: JudgeRegistry
let taskTypeRegistry: TaskTypeRegistry
let promptFragmentRegistry: PromptFragmentRegistry
beforeEach(() => {
  registry = defaultAgentKindRegistry()
  initiativePresetRegistry = new InitiativePresetRegistry()
  gateRegistry = defaultGateRegistry()
  stepResolverRegistry = defaultStepResolverRegistry()
  providerRegistry = defaultProviderRegistry()
  pipelineRegistry = defaultPipelineRegistry()
  judgeRegistry = defaultJudgeRegistry()
  taskTypeRegistry = defaultTaskTypeRegistry()
  // The shipped catalog, so the example's own standards JOIN it rather than replace it, which is
  // what a real composition root does and what the assertions below then read back.
  promptFragmentRegistry = promptFragmentRegistryWithBuiltins()
  registerExampleCustomAgents({
    agentKindRegistry: registry,
    initiativePresetRegistry,
    gateRegistry,
    stepResolverRegistry,
    pipelineRegistry,
    judgeRegistry,
    promptFragmentRegistry,
    taskTypeRegistry,
  })
})

describe('example custom agents', () => {
  it('registers both kinds with the right surfaces', () => {
    expect(registry.get(ORG_REVIEWER_KIND)).toBeTruthy()
    expect(registry.agentStep(ORG_REVIEWER_KIND)?.surface).toBe('inline')
    expect(registry.requiresContainer(ORG_REVIEWER_KIND)).toBe(false)

    expect(registry.agentStep(SECURITY_AUDITOR_KIND)?.surface).toBe('container-explore')
    expect(registry.agentStep(SECURITY_AUDITOR_KIND)?.output?.kind).toBe('structured')
    // A container surface implies the container requirement without `requiresContainer`.
    expect(registry.requiresContainer(SECURITY_AUDITOR_KIND)).toBe(true)
  })

  it('exposes presentation so the kinds become first-class palette blocks', () => {
    const validCategories = new Set(['review', 'design', 'build', 'test', 'docs', 'gates'])
    for (const def of EXAMPLE_AGENT_KINDS) {
      expect(def.presentation?.label).toBeTruthy()
      expect(validCategories.has(def.presentation?.category ?? '')).toBe(true)
    }
    // The two reviewers are review blocks; the license-fixer helper is a build block.
    expect(registry.get(ORG_REVIEWER_KIND)?.presentation?.category).toBe('review')
    expect(registry.get(SECURITY_AUDITOR_KIND)?.presentation?.category).toBe('review')
    expect(registry.get(LICENSE_FIXER_KIND)?.presentation?.category).toBe('build')
    // The auditor opens the shared generic structured viewer.
    expect(registry.get(SECURITY_AUDITOR_KIND)?.presentation?.resultView).toBe('generic-structured')
  })

  it('registers the license-check gate, escalating to the license-fixer helper kind', () => {
    const registered = gateRegistry.factories()
    expect(registered.map((g) => g.kind)).toContain(LICENSE_CHECK_KIND)
    // The helper is itself a registered agent kind (a container-coding fixer).
    expect(registry.agentStep(LICENSE_FIXER_KIND)?.surface).toBe('container-coding')

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
    wireLicenseProvider(providerRegistry, { check })
    const gate = gateRegistry
      .factories()
      .find((g) => g.kind === LICENSE_CHECK_KIND)!
      .factory(stubGateContext({}, providerRegistry))

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
    const registered = stepResolverRegistry.factories()
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
    const pipeline = seedPipelines(pipelineRegistry).find((p) => p.id === ORG_AUDIT_PIPELINE_ID)
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
    const commitFiles = vi.fn<(input: CommitFilesInput) => Promise<{ sha: string }>>(async () => ({
      sha: 'sha',
    }))
    // No report on the branch yet (getFile → null), so the idempotency guard lets the commit through.
    const getFile = vi.fn(async () => null)
    const repo = { getFile, commitFiles } as unknown as RepoFiles
    const [postOp] = registry.postOps(SECURITY_AUDITOR_KIND)
    expect(postOp).toBeTruthy()

    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
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
    const [postOp] = registry.postOps(SECURITY_AUDITOR_KIND)
    const assessment = { risk: 0.1, summary: 'Clean', findings: [] }
    // The branch already holds the byte-identical render the post-op would produce.
    const existing = renderComplianceReport(assessment)
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
    const getFile = vi.fn(async () => ({ content: existing, sha: 'blob-sha' }))
    const repo = { getFile, commitFiles } as unknown as RepoFiles
    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
      context: { agentKind: SECURITY_AUDITOR_KIND } as never,
      result: { output: 'done', custom: assessment },
    })
    // No duplicate commit on a replay that re-runs the post-op after the prior one landed.
    expect(commitFiles).not.toHaveBeenCalled()
  })

  it('post-op is a no-op when the agent returned nothing parseable', async () => {
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
    const repo = { commitFiles } as unknown as RepoFiles
    const [postOp] = registry.postOps(SECURITY_AUDITOR_KIND)
    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
      context: { agentKind: SECURITY_AUDITOR_KIND } as never,
      result: { output: 'no json' },
    })
    expect(commitFiles).not.toHaveBeenCalled()
  })
})

describe('example org-audit initiative preset', () => {
  it('registers the preset on the injected app-owned registry (replace-by-id)', () => {
    // The registration is the same object reference the registry hands back (replace-by-id).
    expect(initiativePresetRegistry.get(ORG_AUDIT_PRESET_ID)).toBe(ORG_AUDIT_PRESET)
    expect(initiativePresetRegistry.all().map((p) => p.descriptor.id)).toContain(
      ORG_AUDIT_PRESET_ID,
    )
  })

  it('advertises a descriptor with probe:false (no detect hook) bound to a real planning pipeline', () => {
    const descriptor = initiativePresetRegistry
      .descriptors()
      .find((d) => d.id === ORG_AUDIT_PRESET_ID)
    expect(descriptor).toBeTruthy()
    // No `detect` hook ⇒ the server-derived probe flag is false, so the SPA never fires a probe.
    expect(descriptor?.probe).toBe(false)
    expect(descriptor?.interview).toBe('full')
    // The planning binding must resolve to a real pipeline (else create/start would 404 the run).
    expect(descriptor?.planningPipelineId).toBe('pl_initiative')
    expect(
      seedPipelines(pipelineRegistry).some((p) => p.id === descriptor?.planningPipelineId),
    ).toBe(true)
  })

  it('declares a single required org-audit phase (shape is the template’s job)', () => {
    const template = ORG_AUDIT_PRESET.descriptor.phaseTemplate
    expect(template?.allowAdditionalPhases).toBe(false)
    expect(template?.phases.map((p) => p.id)).toEqual(['org-audit'])
    expect(template?.phases[0]?.required).toBe(true)
  })

  it('seedPlan DECORATES org-audit items onto pl_org_audit and leaves others untouched', () => {
    // The draft is the planner's InferOutput shape, so the valibot-defaulted fields
    // (`goal`/`description`/`dependsOn`/`rules`/`onMissingEstimate`) are all required here.
    const decorated = ORG_AUDIT_PRESET.seedPlan!(
      {
        goal: '',
        constraints: [],
        nonGoals: [],
        analysisSummary: '',
        phases: [{ id: 'org-audit', title: 'Compliance audit', goal: '' }],
        items: [
          {
            id: 'i1',
            phaseId: 'org-audit',
            title: 'Audit payments',
            description: '',
            dependsOn: [],
          },
          {
            id: 'i2',
            phaseId: 'unrelated',
            title: 'Untouched item',
            description: '',
            dependsOn: [],
          },
        ],
        policy: {
          maxConcurrent: 2,
          defaultPipelineId: 'pl_simple',
          rules: [],
          onMissingEstimate: 'default',
        },
        decisions: [],
        caveats: [],
      },
      {},
    )
    // The org-audit item runs this package's OWN pipeline; the plan shape is unchanged.
    expect(decorated.items[0]?.pipelineId).toBe(ORG_AUDIT_PIPELINE_ID)
    expect(decorated.items[1]?.pipelineId).toBeUndefined()
    expect(decorated.phases.map((p) => p.id)).toEqual(['org-audit'])
  })
})

describe('example org research-and-apply preset', () => {
  it('registers the research kind as a structured container-coding producer', () => {
    // container-CODING (not explore) so it opens a real, mergeable PR — the merge tail can only
    // gate a PR the step reported via `result.pullRequest` (the `repro-test` structured-coding shape).
    expect(registry.agentStep(ORG_RESEARCH_KIND)?.surface).toBe('container-coding')
    expect(registry.agentStep(ORG_RESEARCH_KIND)?.output?.kind).toBe('structured')
    expect(registry.requiresContainer(ORG_RESEARCH_KIND)).toBe(true)
    expect(registry.get(ORG_RESEARCH_KIND)?.presentation?.resultView).toBe('generic-structured')
  })

  it('registers a verdict resolver that folds the verdict into the step output', async () => {
    const resolver = stepResolverRegistry
      .factories()
      .find((r) => r.kind === ORG_RESEARCH_KIND)!
      .factory(stubResolverContext())
    const resolution = await resolver.resolve({
      workspaceId: 'ws',
      instance: { id: 'exec' } as never,
      step: {} as never,
      result: { output: 'done', custom: { verdict: 'NO_GO', summary: 'Vendor API is retiring.' } },
      isFinalStep: false,
    })
    // The human reads this at the checkpoint — a NO_GO is their cue to CANCEL the initiative.
    expect(resolution?.output).toContain('NO_GO')
    expect(resolution?.output).toContain('Vendor API is retiring.')
  })

  it('renders a deterministic research report from the verdict', () => {
    const md = renderResearchReport({
      verdict: 'GO_WITH_CAVEATS',
      summary: 'Feasible with an adapter.',
      findings: [{ title: 'No native pagination', detail: 'Wrap the cursor API.' }],
      openQuestions: ['Rate limits under burst?'],
    })
    expect(md).toContain('# Feasibility research')
    expect(md).toContain('**Verdict:** GO_WITH_CAVEATS')
    expect(md).toContain('Feasible with an adapter.')
    expect(md).toContain('**No native pagination**')
    expect(md).toContain('- Rate limits under burst?')
    // Pure: same input → identical bytes.
    expect(
      renderResearchReport({
        verdict: 'GO_WITH_CAVEATS',
        summary: 'Feasible with an adapter.',
        findings: [{ title: 'No native pagination', detail: 'Wrap the cursor API.' }],
        openQuestions: ['Rate limits under burst?'],
      }),
    ).toBe(md)
  })

  it('post-op commits the report to the seedPlan-derived targetPath on the PR branch', async () => {
    const commitFiles = vi.fn<(input: CommitFilesInput) => Promise<{ sha: string }>>(async () => ({
      sha: 'sha',
    }))
    const getFile = vi.fn(async () => null)
    const repo = { getFile, commitFiles } as unknown as RepoFiles
    const [postOp] = registry.postOps(ORG_RESEARCH_KIND)
    expect(postOp).toBeTruthy()

    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
      // The engine threads the item's `spawn.taskTypeFields` onto the block, so the post-op reads
      // the SAME `targetPath` the seedPlan derived + stamped.
      context: {
        agentKind: ORG_RESEARCH_KIND,
        block: { taskTypeFields: { targetPath: 'docs/research/research-acme.md' } },
      } as never,
      result: { output: 'done', custom: { verdict: 'GO', summary: 'Clear.' } },
    })

    expect(commitFiles).toHaveBeenCalledTimes(1)
    const input = commitFiles.mock.calls[0]![0]!
    expect(input.branch).toBe('cat-factory/blk_1')
    expect(input.files[0]!.path).toBe('docs/research/research-acme.md')
    expect(input.files[0]!.content).toContain('**Verdict:** GO')
  })

  it('post-op is idempotent and a no-op on an unparseable result', async () => {
    const [postOp] = registry.postOps(ORG_RESEARCH_KIND)
    const content = renderResearchReport({ verdict: 'GO', findings: [], openQuestions: [] })
    const commitFiles = vi.fn(async () => ({ sha: 'sha' }))
    // Byte-identical report already on the branch ⇒ the guard skips the commit (replay-safe).
    const repo = {
      getFile: vi.fn(async () => ({ content, sha: 'blob' })),
      commitFiles,
    } as unknown as RepoFiles
    await postOp!({
      repo,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
      context: { agentKind: ORG_RESEARCH_KIND, block: {} } as never,
      result: { output: 'done', custom: { verdict: 'GO' } },
    })
    expect(commitFiles).not.toHaveBeenCalled()

    // Nothing parseable ⇒ no report committed.
    const commitFiles2 = vi.fn(async () => ({ sha: 'sha' }))
    await postOp!({
      repo: { commitFiles: commitFiles2 } as unknown as RepoFiles,
      branch: 'cat-factory/blk_1',
      opensPr: false,
      deliversCheckout: true,
      logger: noopLogger,
      context: { agentKind: ORG_RESEARCH_KIND, block: {} } as never,
      result: { output: 'no json' },
    })
    expect(commitFiles2).not.toHaveBeenCalled()
  })

  it('registers both merging pipelines chaining the kinds + the merge tail', () => {
    const research = seedPipelines(pipelineRegistry).find((p) => p.id === ORG_RESEARCH_PIPELINE_ID)
    expect(research?.agentKinds).toEqual([ORG_RESEARCH_KIND, 'conflicts', 'ci', 'merger'])
    const apply = seedPipelines(pipelineRegistry).find((p) => p.id === ORG_APPLY_PIPELINE_ID)
    expect(apply?.agentKinds).toEqual(['coder', 'conflicts', 'ci', 'merger'])
  })

  it('declares a checkpoint research phase and a required apply phase', () => {
    const template = ORG_RESEARCH_PRESET.descriptor.phaseTemplate
    expect(template?.allowAdditionalPhases).toBe(false)
    expect(template?.phases.map((p) => p.id)).toEqual(['research', 'apply'])
    // The research phase PAUSES the initiative for human review of the committed report (D2).
    expect(template?.phases[0]?.checkpoint).toBe(true)
    expect(template?.phases[0]?.required).toBe(true)
    expect(template?.phases[1]?.checkpoint).toBeUndefined()
    expect(template?.phases[1]?.required).toBe(true)
  })

  it('advertises a full-interview descriptor bound to a real planning pipeline (probe:false)', () => {
    expect(initiativePresetRegistry.get(ORG_RESEARCH_PRESET_ID)).toBe(ORG_RESEARCH_PRESET)
    const descriptor = initiativePresetRegistry
      .descriptors()
      .find((d) => d.id === ORG_RESEARCH_PRESET_ID)
    expect(descriptor?.probe).toBe(false)
    expect(descriptor?.interview).toBe('full')
    expect(descriptor?.planningPipelineId).toBe('pl_initiative')
    expect(
      seedPipelines(pipelineRegistry).some((p) => p.id === descriptor?.planningPipelineId),
    ).toBe(true)
  })

  it('steers the spawned coder + custom research kind via promptAdditions (slice 1 reach)', () => {
    // The `coder` (built-in) and `org-researcher` (custom) additions reach the SPAWNED runs — org
    // methodology folded onto the children without forking either kind.
    expect(ORG_RESEARCH_PRESET.promptAdditions?.coder).toBeTruthy()
    expect(ORG_RESEARCH_PRESET.promptAdditions?.[ORG_RESEARCH_KIND]).toBeTruthy()
  })

  it('seedPlan derives the report path from the frozen topic and routes each phase', () => {
    const decorated = ORG_RESEARCH_PRESET.seedPlan!(
      {
        goal: '',
        constraints: [],
        nonGoals: [],
        analysisSummary: '',
        phases: [
          { id: 'research', title: 'Research', goal: '' },
          { id: 'apply', title: 'Apply', goal: '' },
        ],
        items: [
          {
            id: 'r1',
            phaseId: 'research',
            title: 'Research the Acme API',
            description: '',
            dependsOn: [],
          },
          {
            id: 'a1',
            phaseId: 'apply',
            title: 'Build the connector',
            description: 'Implement it.',
            dependsOn: ['r1'],
          },
        ],
        policy: {
          maxConcurrent: 1,
          defaultPipelineId: 'pl_simple',
          rules: [],
          onMissingEstimate: 'default',
        },
        decisions: [],
        caveats: [],
      },
      { topic: 'the Acme API', docsRoot: 'docs/research' },
    )

    const derivedPath = 'docs/research/research-the-acme-api.md'
    // The research item routes to the merging research pipeline and carries the derived path so the
    // post-op renders to it; the apply item routes to the apply pipeline and NAMES the same path.
    expect(decorated.items[0]?.pipelineId).toBe(ORG_RESEARCH_PIPELINE_ID)
    expect(decorated.items[0]?.spawn?.taskTypeFields?.targetPath).toBe(derivedPath)
    expect(decorated.items[1]?.pipelineId).toBe(ORG_APPLY_PIPELINE_ID)
    expect(decorated.items[1]?.description).toContain(derivedPath)
    // seedPlan never touches phase shape.
    expect(decorated.phases.map((p) => p.id)).toEqual(['research', 'apply'])
  })
})

describe('example scope-adherence judge', () => {
  it("registers on the app-owned judge registry with the org's differentiators only", () => {
    const entry = judgeRegistry
      .factories()
      .find((f: { kind: string }) => f.kind === SCOPE_JUDGE_KIND)
    expect(entry).toBeDefined()
    const judge = entry!.factory(stubJudgeContext())
    // A judge supplies its rubric, its failure disposition and where to bounce — and nothing
    // else. No state machine, no threshold comparison, no park: the engine owns all of that.
    expect(judge.rubric.name).toBe('Scope adherence')
    expect(judge.rubric.body).toContain('nothing beyond it')
    expect(judge.onFail).toBe('bounce')
    expect(judge.bounceTargets).toEqual(['coder'])
    // The rubric names a fragment id, so a workspace can override the body through the prompt
    // library it already uses — which is why this package ships no rubric storage.
    expect(judge.rubric.fragmentId).toBe(SCOPE_RUBRIC_FRAGMENT_ID)
    // Presentation makes it a first-class palette block; the engine defaults its result view.
    expect(judge.presentation?.label).toBe('Scope Adherence')
  })

  it('parses its extended verdict shape and degrades a noisy field instead of dropping it', () => {
    const entry = judgeRegistry
      .factories()
      .find((f: { kind: string }) => f.kind === SCOPE_JUDGE_KIND)!
    const parse = entry.factory(stubJudgeContext()).parseVerdict!
    const verdict = parse({
      score: 0.4,
      summary: 'Refactored an unrelated module.',
      // A score out of the 0..1 range on ONE finding must not discard the finding beside it.
      findings: [{ title: 'Unrelated refactor', severity: 'nonsense' }],
      outOfScopeAreas: ['src/unrelated'],
    }) as { score: number; findings: { title: string; severity: string }[] }
    expect(verdict.score).toBe(0.4)
    expect(verdict.findings[0]?.title).toBe('Unrelated refactor')
    expect(verdict.findings[0]?.severity).toBe('medium')
  })

  it('registers a pipeline that gives the judge a producing step to bounce to', () => {
    // A judge with nothing before it degrades a bounce to a park, so the shipped pipeline must
    // place it AFTER the coder — otherwise the example would silently demonstrate the wrong thing.
    const pipeline = pipelineRegistry.registered().find((p) => p.id === ORG_SCOPE_PIPELINE_ID)!
    expect(pipeline).toBeDefined()
    expect(pipeline.agentKinds.indexOf(SCOPE_JUDGE_KIND)).toBeGreaterThan(
      pipeline.agentKinds.indexOf('coder'),
    )
  })
})

describe('the org:introduce-api reusable operation', () => {
  it('registers the whole bundle on the task type: form, standing context, canned pipeline', () => {
    const operation = taskTypeRegistry.get(INTRODUCE_API_TASK_TYPE)
    expect(operation?.presentation.label).toBe('Introduce API')
    // The picker grouping axis, so an org's twenty operations are captioned rather than flat.
    expect(operation?.presentation.category).toBe('API delivery')
    expect(operation?.defaultPipelineId).toBe(INTRODUCE_API_PIPELINE_ID)
    expect(operation?.defaultFragmentIds).toEqual([...INTRODUCE_API_FRAGMENT_IDS])
    // The per-case form: what a user fills, and what reaches every agent's prompt.
    expect(operation?.fields?.map((f) => f.key)).toEqual([
      'entity',
      'operations',
      'resourceStyle',
      'actionName',
      'authRequirement',
      'notes',
    ])
    expect(operation?.fields?.filter((f) => f.required).map((f) => f.key)).toEqual([
      'entity',
      'operations',
      'authRequirement',
    ])
    // The shared descriptor-form vocabulary the operation draws on: a closed set collected as a
    // multi-select, and a field that appears only for the style that has a verb to name.
    expect(operation?.fields?.find((f) => f.key === 'operations')?.type).toBe('checkbox-group')
    expect(operation?.fields?.find((f) => f.key === 'actionName')?.showWhen).toEqual({
      key: 'resourceStyle',
      equals: 'action',
    })
  })

  it('accepts a filled form and refuses one that contradicts the descriptor', () => {
    // The same pure rule the create controller runs, exercised against a REAL descriptor: an
    // operation's declared options and required fields are the contract, not form-side decoration.
    const fields = taskTypeRegistry.get(INTRODUCE_API_TASK_TYPE)?.fields ?? []
    expect(
      validateDescriptorFields(fields, {
        entity: 'Order',
        operations: ['create', 'list'],
        authRequirement: 'service',
      }),
    ).toEqual([])
    expect(validateDescriptorFields(fields, { entity: 'Order', operations: [] })).toEqual([
      'Field "operations" is required.',
      'Field "authRequirement" is required.',
    ])
    expect(
      validateDescriptorFields(fields, {
        entity: 'Order',
        operations: ['create', 'archive'],
        authRequirement: 'service',
      }),
    ).toEqual(['Field "operations" has an option "archive" outside its choices.'])
    // `actionName` is hidden unless the action style is picked, and a hidden field is neither
    // required nor frozen: the sanitized bag drops the stale answer.
    expect(
      sanitizeDescriptorFields(fields, {
        entity: 'Order',
        operations: ['create'],
        authRequirement: 'service',
        resourceStyle: 'collection',
        actionName: 'refund',
      }),
    ).toEqual({
      entity: 'Order',
      operations: ['create'],
      authRequirement: 'service',
      resourceStyle: 'collection',
    })
  })

  it('registers its standing-context fragments onto the INJECTED pool, each with a brief', () => {
    // The brief is what an implementer kind folds on every turn of its loop; without one the
    // full body is re-sent per turn, which is the cost the two-tier fold exists to avoid.
    for (const id of INTRODUCE_API_FRAGMENT_IDS) {
      const fragment = promptFragmentRegistry.get(id)
      expect(fragment?.brief?.length).toBeGreaterThan(0)
      expect(fragment?.brief?.length).toBeLessThan(fragment!.body.length)
    }
  })

  it('steers its design + build steps through VARIANTS the pipeline selects', () => {
    // Per-kind steering rides the pipeline's own stepOptions rather than a second text channel
    // on the task type: the operation owns its pipeline, so the per-step seam already exists.
    const pipeline = seedPipelines(pipelineRegistry).find((p) => p.id === INTRODUCE_API_PIPELINE_ID)
    expect(pipeline?.agentKinds).toEqual([
      'architect',
      'coder',
      'deployer',
      'tester-api',
      'conflicts',
      'ci',
      'merger',
      'disposer',
    ])
    expect(pipeline?.stepOptions?.[0]?.agentVariantId).toBe(ORG_ARCHITECT_API_VARIANT_ID)
    expect(pipeline?.stepOptions?.[1]?.agentVariantId).toBe(ORG_CODER_API_VARIANT_ID)
    // Both variants VARY a built-in kind rather than introducing one, so every engine decision
    // keyed on `architect`/`coder` (the merge tail, the fork phase) is unchanged.
    expect(registry.variant(ORG_ARCHITECT_API_VARIANT_ID)?.baseKind).toBe('architect')
    expect(registry.variant(ORG_CODER_API_VARIANT_ID)?.baseKind).toBe('coder')
    // Additions, not replacements: they compose with the shipped prompt AND a workspace override.
    expect(registry.variant(ORG_CODER_API_VARIANT_ID)?.promptAddition).toBeTruthy()
    expect(registry.variant(ORG_CODER_API_VARIANT_ID)?.systemPrompt).toBeUndefined()
  })

  it('registers its canned pipeline as a read-only, versioned catalog template', () => {
    // Read off `registered()` rather than `seedPipelines()` on purpose: the seeding path DEFAULTS
    // every built-in's version to 1, so asserting through it would pass for a registration that
    // declared neither half. `builtin` is what keeps the pipeline read-only in a workspace (clone
    // to deviate) and the explicit `version` is the rollout channel: without it the org could seed
    // the operation's pipeline once and never update the boards holding it.
    const registered = pipelineRegistry.registered().find((p) => p.id === INTRODUCE_API_PIPELINE_ID)
    expect(registered?.builtin).toBe(true)
    // Above the seeding path's default of 1, which is the only assertion that can tell a DECLARED
    // version from an absent one and does not have to be re-pinned every time the chain moves. It
    // pins the rollout channel having actually been USED, too: changing a built-in's steps without
    // bumping it leaves every board already holding the old copy on a chain nothing will reseed,
    // and (since the save boundary now judges the lifecycle) one a clone-and-edit cannot save.
    expect(registered?.version).toBeGreaterThan(1)
  })

  it("renders a run's collected parameters under the descriptor's labels", () => {
    // The end of the chain this package exists to prove: the values a user typed on the create
    // form come back out as the labelled brief every agent in the pipeline reads.
    const context = describeCustomTaskType(
      INTRODUCE_API_TASK_TYPE,
      { entity: 'Order', authRequirement: 'service', operations: ['create', 'read', 'list'] },
      taskTypeRegistry.get(INTRODUCE_API_TASK_TYPE),
    )
    expect(context?.label).toBe('Introduce API')
    expect(context?.fields).toEqual([
      { key: 'entity', label: 'Entity or capability to expose', value: 'Order' },
      // The multi-select renders its option CAPTIONS, joined: what the model reads is the form's
      // own vocabulary, not the enum values the row happens to store.
      { key: 'operations', label: 'Operations', value: 'Create, Read one, List' },
      {
        key: 'authRequirement',
        label: 'Auth requirement',
        value: 'Service-to-service machine token',
      },
    ])
  })
})
