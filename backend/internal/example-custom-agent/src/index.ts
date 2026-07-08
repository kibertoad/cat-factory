import type { AgentKindDefinition, AgentKindRegistry } from '@cat-factory/agents'
import { defineStructuredOutput } from '@cat-factory/agents'
import type {
  GateProbe,
  InitiativePresetRegistration,
  InitiativePresetRegistry,
  RepoOp,
  StepCompletionResolver,
} from '@cat-factory/kernel'
import {
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
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

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored RESEARCH kind — the producing agent of the
// `preset_org_research` initiative preset below (a 2-phase "research → apply" methodology).
//
// A feasibility researcher investigates a named topic against the codebase and returns a
// GO / GO_WITH_CAVEATS / NO_GO verdict; the deterministic render of that verdict into a
// committed report is the backend {@link renderResearchDocPostOp}. It is a `container-coding`
// kind (NOT `container-explore`) for one load-bearing reason: the research report must reach
// the INITIATIVE'S NEXT PHASE, which clones the default branch — so it has to land there
// through a merged PR (respecting branch protection), and only a step that reports
// `result.pullRequest` gets a `block.pullRequest` recorded for the `conflicts → ci → merger`
// tail to gate + merge (the CI gate + merger read `block.pullRequest`, set solely from the
// step's `result.pullRequest`; a read-only `container-explore` step opens no PR). This is the
// `repro-test` precedent — a structured coding kind that pushes a commit AND returns a parsed
// JSON `custom` outcome (see `jobBody.ts`). The container writes a working draft (so the PR is
// non-empty); the post-op then renders the CANONICAL report from the verdict, keeping the
// mechanical formatting in backend TypeScript per the custom-agents governing principle.
// ---------------------------------------------------------------------------

/** The custom research kind + the id its committed report lands under (derived per-run). */
export const ORG_RESEARCH_KIND = 'org-researcher'

/** The three feasibility verdicts. A NO_GO is the org's signal to CANCEL the initiative at the checkpoint. */
const RESEARCH_VERDICTS = ['GO', 'GO_WITH_CAVEATS', 'NO_GO'] as const

/**
 * The structured feasibility verdict the {@link ORG_RESEARCH_KIND} agent returns (its coding-kind
 * `custom` JSON — the `repro-test` structured-coding shape). ONE valibot schema derives the engine
 * `agent.output` spec AND the typed `parse`/`safeParse`, with `v.fallback` so a noisy field degrades
 * to its default rather than dropping the whole verdict (mirroring {@link securityAssessment}).
 */
const researchVerdict = defineStructuredOutput(
  v.object({
    /** The go/no-go recommendation; an unparseable/absent value degrades to the cautious middle. */
    verdict: v.fallback(v.picklist(RESEARCH_VERDICTS), 'GO_WITH_CAVEATS'),
    /** One-paragraph summary of the feasibility assessment. */
    summary: v.fallback(v.optional(v.string()), undefined),
    /** Individual findings (fit / risk / prior art), each a short title + optional detail. */
    findings: v.optional(
      v.fallback(
        v.array(
          v.fallback(
            v.object({
              title: v.fallback(v.string(), 'Untitled finding'),
              detail: v.fallback(v.optional(v.string()), undefined),
            }),
            { title: 'Untitled finding' },
          ),
        ),
        [],
      ),
      [],
    ),
    /** Unresolved questions the follow-on implementation must answer. */
    openQuestions: v.optional(v.fallback(v.array(v.string()), []), []),
  }),
)

/** The inferred verdict type — flows straight from the schema, no duplicate interface. */
export type ResearchVerdict = ReturnType<typeof researchVerdict.parse>

/** The fallback report path when a run reaches the post-op without a `seedPlan`-stamped `targetPath`. */
const DEFAULT_RESEARCH_DOC_PATH = 'docs/research/research.md'

/** Render the verdict to deterministic Markdown — pure (same input → same bytes). */
export function renderResearchReport(verdict: ResearchVerdict): string {
  const lines: string[] = ['# Feasibility research', '', `**Verdict:** ${verdict.verdict}`, '']
  if (verdict.summary) lines.push(verdict.summary, '')
  lines.push('## Findings', '')
  if (!verdict.findings?.length) {
    lines.push('_No findings recorded._', '')
  } else {
    for (const f of verdict.findings) {
      lines.push(`- **${f.title}**`)
      if (f.detail) lines.push(`  ${f.detail}`)
    }
    lines.push('')
  }
  if (verdict.openQuestions?.length) {
    lines.push('## Open questions', '')
    for (const q of verdict.openQuestions) lines.push(`- ${q}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * POST-OP: render the verdict to the CANONICAL research report and commit it onto the run's branch
 * (the PR branch the coding agent just opened, resolved by the engine from this kind's `work` clone
 * target). The report path is the one {@link ORG_RESEARCH_PRESET}'s `seedPlan` DERIVED from the
 * frozen `topic` input and stamped on the item's `spawn.taskTypeFields.targetPath` — so the producer
 * (this post-op) and the consumer (the apply phase's coder, whose description names the same path)
 * derive it from ONE source and cannot drift. IDEMPOTENT (byte-identical guard) so a durable-driver
 * replay never double-commits, and a no-op when the agent returned nothing parseable.
 */
const renderResearchDocPostOp: RepoOp = async (ctx) => {
  const verdict = researchVerdict.safeParse(ctx.result?.custom)
  if (!verdict) return
  const path = ctx.context.block.taskTypeFields?.targetPath ?? DEFAULT_RESEARCH_DOC_PATH
  const content = renderResearchReport(verdict)
  const existing = await ctx.repo.getFile(path, ctx.branch)
  if (existing?.content === content) return
  await ctx.repo.commitFiles({
    branch: ctx.branch,
    message: 'docs(research): update feasibility research report',
    files: [{ path, content }],
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
  {
    // The feasibility RESEARCHER — the producing agent of the `preset_org_research` initiative
    // (below). A `container-coding` kind (so it opens a real, mergeable PR) with a `structuredOutput`
    // verdict; the deterministic report render is {@link renderResearchDocPostOp}. See its file
    // header for WHY this is `container-coding` rather than `container-explore`.
    kind: ORG_RESEARCH_KIND,
    systemPrompt:
      'You are a feasibility researcher. Investigate the named topic against this codebase and the ' +
      'wider ecosystem, commit a short working draft of your findings, and return ONLY a JSON object: ' +
      '{ "verdict": "GO|GO_WITH_CAVEATS|NO_GO", "summary": "…", "findings": [{ "title": "…", "detail": ' +
      '"…" }], "openQuestions": ["…"] }. The platform renders the canonical research report from your ' +
      'verdict, so focus on the assessment — not the document formatting.',
    agent: { surface: 'container-coding', clone: { branch: 'work' } },
    structuredOutput: researchVerdict,
    postOps: [renderResearchDocPostOp],
    presentation: {
      label: 'Feasibility Researcher',
      icon: 'i-lucide-telescope',
      color: '#8b5cf6',
      description:
        'Researches a topic against the codebase, commits a feasibility report, and returns a GO/NO_GO verdict.',
      category: 'design',
      // The verdict JSON opens in the shared generic structured viewer (no bespoke window).
      resultView: 'generic-structured',
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
 * VERDICT RESOLVER for the feasibility researcher: after its step finishes, fold the structured
 * verdict into a human-readable step summary so the tracker + the CHECKPOINT REVIEW (the research
 * phase is `checkpoint: true`) read "Verdict: NO_GO — …" at a glance. This is the "verdict gate"
 * shape the tracker describes — the engine NEVER interprets the verdict (a NO_GO is the human's cue
 * to CANCEL the initiative at the checkpoint, not a machine auto-cancel). A no-op when nothing parsed.
 */
const researchVerdictResolver: StepCompletionResolver = {
  kind: ORG_RESEARCH_KIND,
  applies: (result) => result.custom !== undefined,
  resolve: async ({ result }) => {
    const verdict = researchVerdict.safeParse(result.custom)
    if (!verdict) return { output: 'Feasibility research complete: result was not parseable.' }
    const detail = verdict.summary ? ` — ${verdict.summary}` : ''
    return { output: `Feasibility research complete. Verdict: ${verdict.verdict}${detail}` }
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
// by registering it on the app-owned `InitiativePresetRegistry` (no engine change, no per-facade wiring).
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
    // No human-review opt-in: `humanReviewDefault` prefills a `humanReview` FORM field that a
    // `seedPlan` reads to stamp a per-run gate override (the built-in docs-refresh pilot's pattern).
    // This example is decoration-only — its `seedPlan` touches nothing but `pipelineId` — so it
    // exposes no such field and wires no override; the flag stays `false` to match that reality.
    // (The plan itself is still human-reviewed at `pl_initiative`'s post-planner approval gate.)
    humanReviewDefault: false,
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
 * Register the org-compliance-audit initiative preset on the app-owned {@link InitiativePresetRegistry}
 * the composition root injects. Idempotent (the preset registry replaces by id), and called from
 * {@link registerExampleCustomAgents} — the deployment composition root — so a deployment that opts
 * into this package gets the preset in its create-initiative picker with no further wiring.
 */
export function registerOrgAuditPreset(initiativePresetRegistry: InitiativePresetRegistry): void {
  initiativePresetRegistry.register(ORG_AUDIT_PRESET)
}

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored MULTI-PHASE INITIATIVE PRESET — the acceptance proof
// that a deployment can assemble a proprietary "research → apply" methodology from the public
// seams alone. It is the minimal shape of the connector-factory use case (see the tracker
// `docs/initiatives/custom-initiative-definitions.md`) and exercises EVERY seam that initiative
// closed:
//   - a `checkpoint: true` research phase (D2) — the initiative PAUSES after the research merges
//     so a human reads the committed report and RESUMES (GO) or CANCELS (NO_GO);
//   - the custom {@link ORG_RESEARCH_KIND} on a MERGING pipeline (`pl_org_research` carries the
//     `conflicts → ci → merger` tail), whose post-op renders the artifact + verdict resolver folds
//     the verdict into the step output (D3 + the verdict-gate shape);
//   - spawned-run `promptAdditions` for a BUILT-IN kind (`coder`) AND the custom research kind (D1)
//     — org methodology reaching the child runs without forking either kind;
//   - a `seedPlan`-DERIVED artifact path from the frozen `topic` form field, stamped on the research
//     item (for the post-op) AND baked into the apply item description (for the coder) so producer
//     and consumer derive it from ONE source (D3 / the frozen-inputs rule).
//
// Registered on the app-owned `InitiativePresetRegistry` the composition root injects, exactly like
// `preset_org_audit`. See `backend/docs/initiative-presets.md` for the full consumer walkthrough.
// ---------------------------------------------------------------------------

export const ORG_RESEARCH_PRESET_ID = 'preset_org_research'
/** This package's OWN merging pipelines the preset routes each phase's items to. */
export const ORG_RESEARCH_PIPELINE_ID = 'pl_org_research'
export const ORG_APPLY_PIPELINE_ID = 'pl_org_apply'

/**
 * The two phase ids — shared VERBATIM by the phase template, the planner steering, and `seedPlan`
 * (the "define the phase id ONCE, reference it everywhere" contract: the planner must emit these
 * exact ids and the ingest normalizer matches on them). Mirrors `tech-migration/phases.ts`.
 */
const RESEARCH_PHASE_ID = 'research'
const APPLY_PHASE_ID = 'apply'

/** Form field keys — the frozen `topic` drives the DERIVED artifact path (`seedPlan` never sees interview qa). */
const FIELD_TOPIC = 'topic'
const FIELD_DOCS_ROOT = 'docsRoot'
/** Where the committed research report lives by default. */
const DEFAULT_DOCS_ROOT = 'docs/research'

/** Read a trimmed string input, falling back when absent/blank/non-string (the `strInput` shape). */
function strInput(inputs: Record<string, unknown>, key: string, fallback: string): string {
  const value = inputs[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * Derive the research report's repo path from the frozen `topic` + `docsRoot` inputs — a safe,
 * lower-kebab `.md` path (the `taskTypeFieldsSchema` `targetPath` requires `.md`). DETERMINISTIC, so
 * the post-op (producer) and the apply item's description (consumer) stamp the SAME path.
 */
function researchDocPath(topic: string, docsRoot: string): string {
  const slug =
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'topic'
  return `${docsRoot.replace(/\/+$/, '')}/research-${slug}.md`
}

/** The org "research → apply" initiative preset registration (descriptor + code hooks). */
export const ORG_RESEARCH_PRESET: InitiativePresetRegistration = {
  descriptor: {
    id: ORG_RESEARCH_PRESET_ID,
    presentation: {
      label: 'Research & apply',
      icon: 'i-lucide-flask-conical',
      color: '#8b5cf6',
      description:
        'Research a topic to a GO/NO_GO verdict (committed as a report and reviewed at a checkpoint), then apply the approved direction as a change.',
    },
    fields: [
      {
        key: FIELD_TOPIC,
        label: 'Research topic',
        help: 'The tool, library, or approach to research (e.g. a 3rd-party integration to build).',
        type: 'text',
        required: true,
        placeholder: 'e.g. the Acme billing API',
      },
      {
        key: FIELD_DOCS_ROOT,
        label: 'Research docs directory',
        help: 'Where the committed feasibility report lives.',
        type: 'path',
        default: DEFAULT_DOCS_ROOT,
      },
    ],
    // Reuse the built-in generic planning pipeline (interviewer → analyst → planner(gate) →
    // committer) — no new planning pipeline is registered; all deviation is descriptor data + hooks.
    planningPipelineId: 'pl_initiative',
    interview: 'full',
    // Human review is the CHECKPOINT (below), not per-PR gates; the plan itself is human-reviewed at
    // `pl_initiative`'s post-planner approval gate, and the merges auto-run against the merge preset.
    humanReviewDefault: false,
    defaultFragmentIds: [],
    // Serialized phases (research must merge before apply spawns); phase sequencing + the checkpoint
    // enforce the order, this keeps within-phase concurrency to one.
    policyDefaults: { maxConcurrent: 1 },
    // Plan SHAPE: exactly two required phases, no extras. The RESEARCH phase is a CHECKPOINT — the
    // initiative pauses when its item merges so a human reads the committed report before APPLY spawns.
    phaseTemplate: {
      phases: [
        {
          id: RESEARCH_PHASE_ID,
          title: 'Research',
          goal: 'Research the topic to a GO/NO_GO verdict and commit the feasibility report.',
          required: true,
          checkpoint: true,
        },
        {
          id: APPLY_PHASE_ID,
          title: 'Apply',
          goal: 'Apply the approved research direction as a code change.',
          required: true,
        },
      ],
      allowAdditionalPhases: false,
    },
  },
  // DECORATION only (never phases): route each phase's items to this package's OWN merging pipelines
  // and DERIVE the report path from the frozen `topic`, stamping it where BOTH the producer (the
  // research post-op, via `spawn.taskTypeFields.targetPath`) and the consumer (the apply coder, via
  // the item description) read it from one source.
  seedPlan(draft, inputs) {
    const docPath = researchDocPath(
      strInput(inputs, FIELD_TOPIC, 'topic'),
      strInput(inputs, FIELD_DOCS_ROOT, DEFAULT_DOCS_ROOT),
    )
    const items = draft.items.map((item) => {
      if (item.phaseId === RESEARCH_PHASE_ID) {
        return {
          ...item,
          pipelineId: ORG_RESEARCH_PIPELINE_ID,
          spawn: {
            ...item.spawn,
            taskTypeFields: { ...item.spawn?.taskTypeFields, targetPath: docPath },
          },
        }
      }
      if (item.phaseId === APPLY_PHASE_ID) {
        return {
          ...item,
          pipelineId: ORG_APPLY_PIPELINE_ID,
          description:
            `${item.description}\n\nBase your work on the committed feasibility research report at \`${docPath}\` (read it from your checkout before implementing).`.trim(),
        }
      }
      return item
    })
    return { ...draft, items }
  },
  // Per-agent-kind steering (DATA, off the wire descriptor). The analyst/planner additions reach the
  // PLANNING run; the `coder` (built-in) + `org-researcher` (custom) additions reach the SPAWNED runs
  // via slice 1 — org methodology folded onto the children without forking either kind.
  promptAdditions: {
    [INITIATIVE_ANALYST_AGENT_KIND]:
      'Assess what the requested topic entails against this codebase and note what a feasibility ' +
      'report must cover (fit, risks, prior art, open questions) and what the follow-on implementation would touch.',
    [INITIATIVE_PLANNER_AGENT_KIND]:
      `Emit exactly two phases. A "${RESEARCH_PHASE_ID}" phase with ONE research item naming the topic, ` +
      `and an "${APPLY_PHASE_ID}" phase with the implementation item(s) that build on the research verdict. ` +
      'Write each item description to be self-sufficient.',
    [ORG_RESEARCH_KIND]:
      'Ground every finding in concrete evidence from the codebase or the topic’s documentation; state ' +
      'the verdict plainly and justify any NO_GO.',
    coder:
      'Follow the organisation’s implementation conventions, and treat the committed feasibility ' +
      'research report as the authoritative brief for what to build and why.',
  },
}

/** Register the org "research → apply" preset on the app-owned {@link InitiativePresetRegistry}. */
export function registerOrgResearchPreset(
  initiativePresetRegistry: InitiativePresetRegistry,
): void {
  initiativePresetRegistry.register(ORG_RESEARCH_PRESET)
}

/**
 * Register the example kinds on the app-owned {@link AgentKindRegistry} the composition root
 * injects, and the `preset_org_audit` + `preset_org_research` initiative presets on the app-owned
 * {@link InitiativePresetRegistry}, plus the pipelines that chain the kinds (`pl_org_audit`,
 * `pl_org_research`, `pl_org_apply`) + the example `license-check` gate + the auditor-summary /
 * research-verdict step resolvers (the pipeline/gate/step-resolver registries are still
 * module-global — those have not migrated to app-owned DI yet). Idempotent (registries replace by
 * id/kind). Called explicitly from a facade/test — there is no module-load side effect any more,
 * since the agent-kind + preset registries are app-owned instances, not globals.
 */
export function registerExampleCustomAgents(
  registry: AgentKindRegistry,
  initiativePresetRegistry: InitiativePresetRegistry,
): void {
  registry.registerAll(EXAMPLE_AGENT_KINDS)
  registerPipeline({
    id: ORG_AUDIT_PIPELINE_ID,
    name: 'Org compliance audit',
    agentKinds: [ORG_REVIEWER_KIND, SECURITY_AUDITOR_KIND],
  })
  // The `preset_org_research` pipelines: a research producer + an apply coder, each on the universal
  // `conflicts → ci → merger` merge tail so the committed report (and the follow-on change) land on
  // the default branch a later phase clones. The merge tail is what makes the research artifact a
  // cross-phase artifact (see `ORG_RESEARCH_PRESET`).
  registerPipeline({
    id: ORG_RESEARCH_PIPELINE_ID,
    name: 'Org feasibility research',
    agentKinds: [ORG_RESEARCH_KIND, 'conflicts', 'ci', 'merger'],
  })
  registerPipeline({
    id: ORG_APPLY_PIPELINE_ID,
    name: 'Org apply',
    agentKinds: ['coder', 'conflicts', 'ci', 'merger'],
  })
  registerOrgAuditPreset(initiativePresetRegistry)
  registerOrgResearchPreset(initiativePresetRegistry)
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
  registerStepResolver(researchVerdictResolver.kind, () => researchVerdictResolver)
}
