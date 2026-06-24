import type { AgentKindDefinition } from '@cat-factory/agents'
import { registerAgentKinds } from '@cat-factory/agents'
import type { RepoOp } from '@cat-factory/kernel'
import { registerPipeline } from '@cat-factory/kernel'

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

/** Where the security auditor's rendered report lands in the repo. */
const REPORT_PATH = 'compliance/REPORT.md'

/**
 * The structured assessment the {@link SECURITY_AUDITOR_KIND} agent returns (its
 * `container-explore` structured output, surfaced by the engine as `result.custom`). The
 * post-op coerces leniently — a model may omit fields — then renders + commits the report.
 */
export interface SecurityAssessment {
  /** Overall risk rating, 0..1 (higher = riskier). */
  risk?: number
  /** One-paragraph summary of the security posture of the change. */
  summary?: string
  /** Individual findings, each a short title + optional detail + severity. */
  findings?: { title: string; detail?: string; severity?: 'low' | 'medium' | 'high' | 'critical' }[]
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
type Severity = (typeof SEVERITIES)[number]
const isSeverity = (v: unknown): v is Severity => SEVERITIES.includes(v as Severity)

/** Coerce the model's free-form JSON into a {@link SecurityAssessment} (never throws). */
function coerceAssessment(value: unknown): SecurityAssessment {
  const obj = (value ?? {}) as Record<string, unknown>
  const findings: NonNullable<SecurityAssessment['findings']> = Array.isArray(obj.findings)
    ? obj.findings.map((f) => {
        const o = (f ?? {}) as Record<string, unknown>
        return {
          title: typeof o.title === 'string' ? o.title : 'Untitled finding',
          ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
          ...(isSeverity(o.severity) ? { severity: o.severity } : {}),
        }
      })
    : []
  return {
    ...(typeof obj.risk === 'number' ? { risk: obj.risk } : {}),
    ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
    findings,
  }
}

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
  if (ctx.result?.custom === undefined) return
  const content = renderComplianceReport(coerceAssessment(ctx.result.custom))
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
    agent: {
      surface: 'container-explore',
      output: {
        kind: 'structured',
        shapeHint:
          '{ "risk": number 0..1, "summary": string, "findings": [{ "title": string, ' +
          '"detail": string, "severity": "low"|"medium"|"high"|"critical" }] }',
      },
      clone: { branch: 'pr' },
    },
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
]

/**
 * Register the example kinds + the `pl_org_audit` pipeline that chains them. Idempotent
 * (registry replaces by id), so importing the package and calling this explicitly are safe
 * to combine. Called automatically as an import side effect below.
 */
export function registerExampleCustomAgents(): void {
  registerAgentKinds(EXAMPLE_AGENT_KINDS)
  registerPipeline({
    id: ORG_AUDIT_PIPELINE_ID,
    name: 'Org compliance audit',
    agentKinds: [ORG_REVIEWER_KIND, SECURITY_AUDITOR_KIND],
  })
}

// Side-effect registration: `import '@cat-factory/example-custom-agent'` is enough.
registerExampleCustomAgents()
