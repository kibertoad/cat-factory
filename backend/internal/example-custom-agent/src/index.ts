import type { AgentKindDefinition } from '@cat-factory/agents'
import { defineStructuredOutput, registerAgentKinds } from '@cat-factory/agents'
import type { GateProbe, RepoOp, StepCompletionResolver } from '@cat-factory/kernel'
import {
  defineProviderToken,
  isProviderWired,
  registerGate,
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
// extension seams (`registerAgentKind` + `registerPipeline`) — and ships its mechanical
// work as ordinary backend TypeScript. Crucially it requires ZERO changes to the
// executor-harness image: the container runs the generic LLM-over-a-checkout `agent` kind,
// and the deterministic "render a report file + commit it" step is a backend POST-OP over
// the checkout-free `RepoFiles` port (no clone, runtime-symmetric across Worker/Node/local).
//
// A deployment opts in by importing the package once for its side effect, exactly like a
// model-provider mix-in:
//
//   import '@cat-factory/example-custom-agent'   // registers the kinds + pipeline
//
// or by calling {@link registerExampleCustomAgents} explicitly (e.g. from a facade's
// composition root, or a test that wants to control timing).
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
    /** Overall risk rating, 0..1 (higher = riskier). */
    risk: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    /** One-paragraph summary of the security posture of the change. */
    summary: v.optional(v.string()),
    /** Individual findings, each a short title + optional detail + severity. */
    findings: v.optional(
      v.array(
        v.object({
          title: v.fallback(v.string(), 'Untitled finding'),
          detail: v.optional(v.string()),
          severity: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
        }),
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

/**
 * Register the example kinds + the `pl_org_audit` pipeline that chains them, plus the
 * example `license-check` gate + the auditor summary resolver. Idempotent (registries
 * replace by id/kind), so importing the package and calling this explicitly are safe to
 * combine. Called automatically as an import side effect below.
 */
export function registerExampleCustomAgents(): void {
  registerAgentKinds(EXAMPLE_AGENT_KINDS)
  registerPipeline({
    id: ORG_AUDIT_PIPELINE_ID,
    name: 'Org compliance audit',
    agentKinds: [ORG_REVIEWER_KIND, SECURITY_AUDITOR_KIND],
  })
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

// Side-effect registration: `import '@cat-factory/example-custom-agent'` is enough.
registerExampleCustomAgents()
