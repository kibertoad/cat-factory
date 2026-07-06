import type { AgentKindDefinition, AgentKindRegistry } from '@cat-factory/agents'
import { defineStructuredOutput } from '@cat-factory/agents'
import type {
  GateProbe,
  InitiativePresetRegistration,
  RepoOp,
  StepCompletionResolver,
} from '@cat-factory/kernel'
import {
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
  defineProviderToken,
  isProviderWired,
  registerGate,
  registerInitiativePreset,
  registerPipeline,
  registerStepResolver,
  wireProvider,
} from '@cat-factory/kernel'
import * as v from 'valibot'

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored agent package.
//
// This is what a proprietary "org agents" package looks like: it teaches the platform
// two brand-new agent kinds and a pipeline that chains them — purely through the public
// extension seams (the app-owned `AgentKindRegistry` + `registerPipeline`) — and ships its
// mechanical work as ordinary backend TypeScript. Crucially it requires ZERO changes to the
// executor-harness image: the container runs the generic LLM-over-a-checkout `agent` kind,
// and the deterministic "render a report file + commit it" step is a backend POST-OP over
// the checkout-free `RepoFiles` port (no clone, runtime-symmetric across Worker/Node/local).
//
// A deployment opts in from its composition root by registering its kinds BY REFERENCE on
// the `AgentKindRegistry` instance it injects into the facade build, then passing that same
// instance in:
//
//   const registry = defaultAgentKindRegistry()
//   registerExampleCustomAgents(registry)        // registers the kinds + pipeline + gate
//   start({ agentKindRegistry: registry })        // (or buildContainer / startLocal)
//
// See `backend/docs/custom-agents.md` for the full model.
// ---------------------------------------------------------------------------

export const ORG_REVIEWER_KIND = 'org-reviewer'
export const SECURITY_AUDITOR_KIND = 'security-auditor'
export const ORG_AUDIT_PIPELINE_ID = 'pl_org_audit'

/** The custom polling-gate step kind + the helper agent it escalates to on a red verdict. */
export const LICENSE_CHECK_KIND = 'license-check'
export const LICENSE_FIXER_KIND = 'license-fixer'

/** Where the security auditor's rendered report lands in the repo. */
const REPORT_PATH = 'compliance/REPORT.md'

/**
 * The structured assessment the {@link SECURITY_AUDITOR_KIND} agent returns (its
 * `container-explore` structured output, surfaced by the engine as `result.custom`).
 *
 * ONE valibot schema is the whole story: {@link defineStructuredOutput} derives the engine
 * `agent.output` spec (the `shapeHint` the harness's repair call sees) AND a typed
 * `parse`/`safeParse`. There is no hand-written `SecurityAssessment` interface, no `shapeHint`
 * string, and no lenient `coerceAssessment` coercer to keep in sync — `v.fallback`/`v.optional`
 * make `safeParse` degrade gracefully (a model may omit fields) exactly like the old coercer.
 */
const securityAssessment = defineStructuredOutput(
  v.object({
    // Each constrained field is wrapped in `v.fallback` so ONE noisy field degrades to its
    // default instead of failing the whole parse — the old hand-written coercer never threw, and
    // `safeParse` must match that (a model that reports `risk` on a 0..100 scale, or `findings` as
    // a stray string, would otherwise drop an entire valid assessment and commit no report).
    // `fallback(optional(…), undefined)` keeps the `0..1` (etc.) constraint but degrades a
    // present-but-invalid value to `undefined` instead of failing the whole object — `optional`
    // alone only handles an ABSENT key, so the fallback is what makes `safeParse` non-throwing on
    // a noisy field, matching the old coercer (`optional` is inside so `undefined` is a legal output).
    /** Overall risk rating, 0..1 (higher = riskier); out-of-range/non-numeric ⇒ omitted. */
    risk: v.fallback(v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))), undefined),
    /** One-paragraph summary of the security posture of the change. */
    summary: v.fallback(v.optional(v.string()), undefined),
    /** Individual findings, each a short title + optional detail + severity. */
    findings: v.optional(
      // Outer fallback: a non-array `findings` (e.g. a stray string) ⇒ `[]`. Inner per-item
      // fallback: one malformed entry degrades to an "Untitled finding" placeholder instead of
      // failing the whole array — so a single bad item can't discard the good findings beside it.
      v.fallback(
        v.array(
          v.fallback(
            v.object({
              title: v.fallback(v.string(), 'Untitled finding'),
              detail: v.fallback(v.optional(v.string()), undefined),
              severity: v.fallback(
                v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
                undefined,
              ),
            }),
            { title: 'Untitled finding' },
          ),
        ),
        [],
      ),
      [],
    ),
  }),
)

/** The inferred assessment type — flows straight from the schema, no duplicate interface. */
export type SecurityAssessment = ReturnType<typeof securityAssessment.parse>

/** Render the assessment to deterministic Markdown — pure (same input → same bytes). */
export function renderComplianceReport(assessment: SecurityAssessment): string {
  const lines: string[] = ['# Security compliance report', '']
  if (assessment.risk !== undefined) {
    lines.push(`**Overall risk:** ${(assessment.risk * 100).toFixed(0)}%`, '')
  }
  if (assessment.summary) lines.push(assessment.summary, '')
  lines.push('## Findings', '')
  if (!assessment.findings?.length) {
    lines.push('_No findings — the change is clear._', '')
  } else {
    for (const f of assessment.findings) {
      lines.push(`- **${f.title}**${f.severity ? ` _(${f.severity})_` : ''}`)
      if (f.detail) lines.push(`  ${f.detail}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * POST-OP: render the auditor's structured assessment to `compliance/REPORT.md` and commit
 * it onto the run's branch — DETERMINISTIC backend work over the checkout-free RepoFiles
 * port. This is the whole point of the model: the mechanical render lives here, in plain
 * TypeScript, never in a per-kind branch inside the container. A no-op when the agent
 * returned nothing parseable (so a malformed run doesn't commit an empty report).
 *
 * IDEMPOTENT: the render is deterministic, so we read the report already on the branch and
 * skip the commit when it's byte-identical. This matters because a post-op runs inside
 * `recordStepResult` BEFORE the run state is persisted — a durable-driver replay (Workflows
 * / pg-boss) that re-enters after the commit landed but before the upsert would otherwise
 * push a duplicate commit. The template every deployment copies should model this guard.
 */
const renderReportPostOp: RepoOp = async (ctx) => {
  // safeParse returns undefined on a malformed reply → the no-op guard holds (no empty report).
  const assessment = securityAssessment.safeParse(ctx.result?.custom)
  if (!assessment) return
  const content = renderComplianceReport(assessment)
  const existing = await ctx.repo.getFile(REPORT_PATH, ctx.branch)
  if (existing?.content === content) return
  await ctx.repo.commitFiles({
    branch: ctx.branch,
    message: 'chore(compliance): update security audit report',
    files: [{ path: REPORT_PATH, content }],
  })
}

/** The two example kinds + their wiring (presentation, surfaces, post-op). */
export const EXAMPLE_AGENT_KINDS: AgentKindDefinition[] = [
  {
    // An INLINE custom reviewer: a one-shot LLM call over the block context, no repo, no
    // container. The simplest possible custom agent — works end-to-end with no harness
    // changes and no facade wiring beyond importing this package.
    kind: ORG_REVIEWER_KIND,
    systemPrompt:
      'You are an organisation policy reviewer. Review the change description against the ' +
      "company's engineering policies (security, data-handling, accessibility) and report " +
      'any concerns, with a clear pass/fail recommendation.',
    agent: { surface: 'inline' },
    presentation: {
      label: 'Org Policy Reviewer',
      icon: 'i-lucide-scale',
      color: '#f59e0b',
      description: "Reviews a change against the company's engineering policies.",
      category: 'review',
    },
  },
  {
    // A CONTAINER read-only auditor that explores the checkout and returns a structured
    // JSON assessment (surfaced as `result.custom`); the deterministic render + commit of
    // `compliance/REPORT.md` is the backend post-op above. Its result opens in the generic
    // structured viewer — a custom agent gets a usable result window with no bespoke UI.
    kind: SECURITY_AUDITOR_KIND,
    systemPrompt:
      'You are a security auditor. Explore the repository (read-only) and assess the security ' +
      'posture of the current change. Return ONLY a JSON object: { "risk": 0..1, "summary": ' +
      '"…", "findings": [{ "title": "…", "detail": "…", "severity": "low|medium|high|critical" }] }.',
    // `agent.output` is auto-derived from `structuredOutput.spec` by `registerAgentKind` — the
    // schema below is the single source for both the shapeHint and the post-op's parser.
    agent: {
      surface: 'container-explore',
      clone: { branch: 'pr' },
    },
    structuredOutput: securityAssessment,
    postOps: [renderReportPostOp],
    presentation: {
      label: 'Security Auditor',
      icon: 'i-lucide-shield-check',
      color: '#ef4444',
      description:
        'Read-only security audit of the change; renders a compliance report into the repo.',
      category: 'review',
      // Open the agent's structured JSON in the shared generic viewer (no bespoke window).
      resultView: 'generic-structured',
    },
  },
  {
    // The HELPER agent the `license-check` gate (below) escalates to on a red verdict: a
    // container-coding agent that clones the PR branch, adds the missing license headers,
    // and pushes back onto the same branch (no new PR) — exactly like the built-in
    // `ci-fixer` relates to the `ci` gate. A custom gate's helper is just a registered
    // agent kind; the gate seam needs no new dispatch machinery.
    kind: LICENSE_FIXER_KIND,
    systemPrompt:
      'You are a license-header fixer. Add the required company SPDX license header to every ' +
      'source file in the change that is missing it, leaving all other content untouched. ' +
      'Commit and push your changes; do NOT open a pull request.',
    agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    presentation: {
      label: 'License Fixer',
      icon: 'i-lucide-file-pen',
      color: '#10b981',
      description: 'Adds missing license headers to the change and pushes the fix.',
      category: 'build',
    },
  },
]

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored polling GATE + a step-completion RESOLVER.
//
// A gate is the OTHER half of the extension story (alongside agents): a deterministic
// programmatic precheck that only escalates to a helper agent on a negative verdict — the
// "skip the expensive work when it's unnecessary" contract the built-in `ci` / `conflicts`
// gates use. Here `license-check` checks that the change carries the required license
// headers and only spins up the `license-fixer` agent when something is missing.
//
// Like a custom model provider, the gate's data source (the `LicenseProvider`) is wired by
// the deployment at startup via {@link wireLicenseProvider}; the gate factory closes over
// it. Until it's wired the gate is a harmless pass-through, so a bare
// `import '@cat-factory/example-custom-agent'` is always safe.
// ---------------------------------------------------------------------------

/** The verdict the deployment-supplied license checker returns for a block's PR. */
export interface LicenseCheckReport {
  /** Whether every file in the change carries the required header. */
  clean: boolean
  /** The PR head commit the check ran against, or null when there is no open PR. */
  headSha: string | null
  /** A short human-readable summary (the failing files, on a red verdict). */
  summary?: string
}

/** The deployment-supplied data source for the {@link LICENSE_CHECK_KIND} gate. */
export interface LicenseProvider {
  check(workspaceId: string, blockId: string): Promise<LicenseCheckReport>
}

// The provider is wired into the typed kernel provider registry at startup; the gate reads it
// back through its `GateContext` (no hand-authored module global). Unwired ⇒ the gate passes
// through (see `wired()` below). Defining a token + a one-line `wireX` is the WHOLE plumbing —
// the old `let provider; getProvider()!` pattern (and its unsafe non-null assertion) is gone.
export const LICENSE_PROVIDER = defineProviderToken<LicenseProvider>('license')

/** Wire (or clear) the license checker the {@link LICENSE_CHECK_KIND} gate probes. */
export function wireLicenseProvider(provider: LicenseProvider | undefined): void {
  wireProvider(LICENSE_PROVIDER, provider)
}

/**
 * POST-COMPLETION RESOLVER for the security auditor: after its step finishes, fold the
 * structured assessment into a deterministic human-readable step summary. A resolver is the
 * seam for backend follow-up the engine drives from the agent's result — distinct from a
 * post-op (which writes the repo): this one just shapes what the run-detail UI shows. A
 * no-op when the agent returned nothing parseable.
 */
const auditorSummaryResolver: StepCompletionResolver = {
  kind: SECURITY_AUDITOR_KIND,
  applies: (result) => result.custom !== undefined,
  resolve: async ({ result }) => {
    const assessment = securityAssessment.safeParse(result.custom)
    if (!assessment) return { output: 'Security audit complete: result was not parseable.' }
    const count = assessment.findings?.length ?? 0
    const risk =
      assessment.risk !== undefined ? ` (risk ${(assessment.risk * 100).toFixed(0)}%)` : ''
    return { output: `Security audit complete: ${count} finding(s)${risk}.` }
  },
}

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored INITIATIVE PRESET.
//
// The THIRD extension seam (alongside agent kinds + gates): an initiative preset bundles a
// backend-supplied FORM the user fills at create time, a planning-pipeline binding, a
// declarative phase template, per-kind planning-prompt steering, and a `seedPlan` hook that
// DECORATES the tasks the initiative loop spawns. This one turns the generic initiative into an
// "org compliance audit": the analyst inventories the services, the planner emits one audit item
// per in-scope service, and `seedPlan` routes every item to this package's OWN `pl_org_audit`
// pipeline — so a deployment can add a first-class initiative shape that runs its own agent kinds,
// through the public `registerInitiativePreset` seam ALONE (no engine change, no per-facade wiring).
//
// It mirrors the built-in `preset_docs_refresh` (`@cat-factory/agents`) but stays deliberately
// minimal: `interview: 'full'` reuses the built-in `pl_initiative` planning pipeline (so there is
// no new planning pipeline to register), and `seedPlan` does DECORATION only — it never touches
// the plan's phase structure (that is the declarative `phaseTemplate`'s job, enforced by the
// generic ingest normalizer). See `backend/docs/initiative-presets.md` for the full model.
// ---------------------------------------------------------------------------

export const ORG_AUDIT_PRESET_ID = 'preset_org_audit'

/**
 * The single audit phase id — shared VERBATIM by the phase template, the planner steering, and
 * `seedPlan` (the "define the phase id ONCE, reference it everywhere" contract the phase-template
 * machinery relies on: the planner must emit this exact id and the ingest normalizer matches on it).
 */
const ORG_AUDIT_PHASE_ID = 'org-audit'

/** The policy areas the user checkboxes; the analyst/planner steering keys off the selection. */
const AUDIT_AREA_OPTIONS = [
  { value: 'licensing', label: 'Licensing' },
  { value: 'security', label: 'Security' },
  { value: 'dependencies', label: 'Dependency hygiene' },
]

/** The org-compliance-audit initiative preset registration (descriptor + code hooks). */
export const ORG_AUDIT_PRESET: InitiativePresetRegistration = {
  descriptor: {
    id: ORG_AUDIT_PRESET_ID,
    presentation: {
      label: 'Org compliance audit',
      icon: 'i-lucide-clipboard-check',
      color: '#f59e0b',
      description:
        'Inventory every service and audit each against the org policy, committing a compliance report per service.',
    },
    fields: [
      {
        key: 'auditAreas',
        label: 'Audit areas',
        help: 'Which policy areas each in-scope service is audited against.',
        type: 'checkbox-group',
        options: AUDIT_AREA_OPTIONS,
        defaultValues: AUDIT_AREA_OPTIONS.map((o) => o.value),
      },
      {
        key: 'scopeHint',
        label: 'Scope (optional)',
        help: 'Limit the audit to specific services or areas. Leave blank to cover the whole frame.',
        type: 'textarea',
        placeholder: 'e.g. the payments and identity services only',
      },
    ],
    // Reuse the built-in generic planning pipeline — interviewer → analyst → planner(gate) →
    // committer — so no new planning pipeline is registered; all deviation is descriptor data + hooks.
    planningPipelineId: 'pl_initiative',
    interview: 'full',
    humanReviewDefault: true,
    defaultFragmentIds: [],
    // Plan SHAPE: exactly one required `org-audit` phase (`allowAdditionalPhases: false`), enforced by
    // the generic ingest normalizer — this preset NEVER hand-rolls shape in `seedPlan`.
    phaseTemplate: {
      phases: [
        {
          id: ORG_AUDIT_PHASE_ID,
          title: 'Compliance audit',
          goal: 'Audit each in-scope service against the selected policy areas and commit its report.',
          required: true,
        },
      ],
      allowAdditionalPhases: false,
    },
  },
  // DECORATION only — route every audit item to this package's own pipeline. NEVER touches phases.
  seedPlan(draft) {
    const items = draft.items.map((item) =>
      item.phaseId === ORG_AUDIT_PHASE_ID ? { ...item, pipelineId: ORG_AUDIT_PIPELINE_ID } : item,
    )
    return { ...draft, items }
  },
  // Per-kind planning-prompt steering (DATA, off the wire descriptor). The frozen form values reach
  // the prompt via the seeded interview digest, so these carry METHODOLOGY, not the form answers.
  promptAdditions: {
    [INITIATIVE_ANALYST_AGENT_KIND]:
      'Inventory every service in scope and, per service, note which of the requested audit areas ' +
      '(licensing, security, dependency hygiene) apply and what evidence a compliance report would need.',
    [INITIATIVE_PLANNER_AGENT_KIND]:
      `Emit a single "${ORG_AUDIT_PHASE_ID}" phase with ONE audit item per in-scope service. Each ` +
      "item runs the org compliance audit and commits that service's compliance report; write a " +
      'self-sufficient description naming the service and the audit areas to cover.',
  },
}

/**
 * Register the org-compliance-audit initiative preset. Idempotent (the preset registry replaces by
 * id), and called from {@link registerExampleCustomAgents} — the deployment composition root — so a
 * deployment that opts into this package gets the preset in its create-initiative picker with no
 * further wiring. Tests that `clearRegisteredInitiativePresets()` call this to restore it.
 */
export function registerOrgAuditPreset(): void {
  registerInitiativePreset(ORG_AUDIT_PRESET)
}

/**
 * Register the example kinds on the app-owned {@link AgentKindRegistry} the composition root
 * injects, plus the `pl_org_audit` pipeline that chains them, the example `license-check`
 * gate + the auditor summary resolver, and the `preset_org_audit` initiative preset (all still on
 * the module-global pipeline/gate/step-resolver/preset registries — those registries have not
 * migrated to app-owned DI yet). Idempotent (registries replace by id/kind). Called explicitly from
 * a facade/test — there is no module-load side effect any more, since the agent-kind registry is an
 * app-owned instance, not a global.
 */
export function registerExampleCustomAgents(registry: AgentKindRegistry): void {
  registry.registerAll(EXAMPLE_AGENT_KINDS)
  registerPipeline({
    id: ORG_AUDIT_PIPELINE_ID,
    name: 'Org compliance audit',
    agentKinds: [ORG_REVIEWER_KIND, SECURITY_AUDITOR_KIND],
  })
  registerOrgAuditPreset()
  // The custom polling gate — a deterministic precheck that escalates to `license-fixer`.
  registerGate(LICENSE_CHECK_KIND, (ctx) => ({
    kind: LICENSE_CHECK_KIND,
    helperKind: LICENSE_FIXER_KIND,
    wired: () => isProviderWired(LICENSE_PROVIDER),
    unwiredOutput: 'License gate skipped (no license provider configured).',
    probe: async (workspaceId, blockId): Promise<GateProbe> => {
      // requireProvider is safe here: the engine only probes a gate whose wired() is true.
      const report = await ctx.requireProvider(LICENSE_PROVIDER).check(workspaceId, blockId)
      if (report.clean) {
        return {
          status: 'pass',
          headSha: report.headSha,
          passOutput: report.summary ?? 'License gate passed: all files carry the required header.',
        }
      }
      return {
        status: 'fail',
        headSha: report.headSha,
        failureSummary: report.summary ?? 'Some files are missing the required license header.',
      }
    },
    // Hand the failing-file summary to the fixer as resolved context, like the CI gate.
    helperPriorOutput: (summary) => ({ agentKind: LICENSE_CHECK_KIND, output: summary }),
    onExhausted: async ({ workspaceId, instance, block, step, summary }) => {
      const attempts = step.gate?.attempts ?? 0
      await ctx.raiseNotification(workspaceId, {
        type: 'decision_required',
        blockId: block.id,
        executionId: instance.id,
        title: 'License headers still missing',
        body:
          `The change still has files missing the required license header after ` +
          `${attempts} fixer attempt(s). ${summary ?? ''}`.trim(),
      })
      return {
        error:
          `License headers still missing after ${attempts} fixer attempt(s). ${summary ?? ''}`.trim(),
      }
    },
  }))
  registerStepResolver(auditorSummaryResolver.kind, () => auditorSummaryResolver)
}
