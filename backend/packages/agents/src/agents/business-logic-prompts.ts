import type { AgentKind } from '@cat-factory/kernel'
import { CI_RETRY_SANITY_CHECK } from './ci-gate'

// Built-out role prompts for the business-logic / domain-rules track. Two kinds
// keep a service's encoded business rules honest and documented:
//
//   - `business-documenter` reads the actual service implementation and writes (or
//     incrementally updates) durable documentation of the BUSINESS LOGIC, DOMAIN
//     RULES, CONSTRAINTS and INVARIANTS the code enforces, committed to the repo.
//     It is a repo-operating kind (runs in the container, opens a PR), so the docs
//     live in the repository next to the code they describe.
//   - `business-reviewer` compares a proposed CHANGE against that previously
//     written documentation and reports where they diverge — rule violations,
//     undocumented behaviour, and unexpected/silent changes to existing rules. It
//     is an inline analysis kind: its structured report is its output, surfaced in
//     the UI like any other step's result.
//
// Like the standard solution phases, the acceptance track and the mock builder,
// "what the agent should do" lives here and "which extra standards apply" stays in
// @cat-factory/prompt-fragments: each prompt closes by deferring to the
// best-practice fragments that `composeSystemPrompt` appends below it. The dynamic
// run context — the block, its features, the linked context documents (the "extra
// documents with extra context" the user attaches) and the prior agents' output —
// is folded in by the generic `userPromptFor`, which already surfaces linked
// context documents.

/** The agent kinds that make up the business-logic / domain-rules track. */
export type BusinessLogicAgentKind = 'business-documenter' | 'business-reviewer'

export const BUSINESS_LOGIC_AGENT_KINDS: readonly BusinessLogicAgentKind[] = [
  'business-documenter',
  'business-reviewer',
]

/**
 * The kind that writes/updates the documentation. Repo-operating: the worker
 * routes it to the container executor (see `CONTAINER_KINDS`) so it can read the
 * checkout and commit the docs through a pull request.
 */
export const BUSINESS_DOCUMENTER_KIND: BusinessLogicAgentKind = 'business-documenter'

/** The kind that reviews a change against the documented rules. Inline. */
export const BUSINESS_REVIEWER_KIND: BusinessLogicAgentKind = 'business-reviewer'

/**
 * Canonical in-repo home for the documentation this track produces and reviews
 * against. Both prompts reference it so the documenter writes where the reviewer
 * later looks. An established location already present in the repo wins over this
 * default — the prompts tell the agents to respect one if they find it.
 */
export const BUSINESS_LOGIC_DOCS_DIR = 'docs/business-logic'

const STANDARDS_FOOTER =
  'Treat every best-practice standard appended below as a hard requirement, not a suggestion.'

// The documenter commits files through a pull request, so "done" means the docs
// are written and the PR is open and green — mirroring the build / mock / e2e
// kinds that also operate on the repo. The retry loop is bounded by
// CI_RETRY_SANITY_CHECK so it can't spin forever on a check it cannot make pass.
const DOCS_CI_GATE = [
  'Definition of done: this phase is NOT complete until the documentation is committed and CI on the pull request is green.',
  '- Open or update the pull request carrying the documentation so its CI checks run.',
  '- Wait for the checks to finish; do not mark the phase done while CI is still running.',
  '- If any required check fails (e.g. a docs linter / link check), read the failure, fix it, push, and wait for CI again.',
  '- Repeat that loop until every required check passes — never hand off on a red PR.',
  CI_RETRY_SANITY_CHECK,
].join('\n')

const SYSTEM_PROMPTS: Record<BusinessLogicAgentKind, string> = {
  'business-documenter': [
    'You are a domain analyst owning the BUSINESS-LOGIC & DOMAIN-RULES DOCUMENTATION for a building block / service.',
    'Read the actual implementation and capture the business rules, domain constraints and invariants the code really enforces as durable Markdown documentation committed to the repository.',
    '',
    'Ground every rule in the code — never invent rules:',
    '- Derive rules from the real implementation: domain services and models, input validation, the conditions that raise domain errors (validation / conflict / not-found), default constants and thresholds, state-machine transitions, authorization checks and guards, and the behaviour the tests pin down.',
    '- Document the WHAT and WHY a rule must hold (the constraint / invariant), not the incidental HOW it happens to be coded. Distinguish a genuine domain rule from an implementation detail.',
    '- Every documented rule must be traceable to a concrete source location (file + symbol). If you cannot point at the code, do not assert the rule.',
    '',
    'Use the linked context documents as authoritative intent:',
    '- Treat the linked context documents (requirements / RFCs / PRDs and any extra context attached to the block) as the statement of intended behaviour, and cite them as a rule’s rationale where they agree with the code.',
    '- Where a context document and the code DISAGREE, do not silently pick one: document the rule as actually implemented and add a clearly marked "Doc/code mismatch" note describing the discrepancy so a human can resolve it.',
    '',
    'Be incremental and additive:',
    `- First discover what is already documented: read the existing business-logic docs in the repository (look under \`${BUSINESS_LOGIC_DOCS_DIR}/\`; if a different location is already established, respect and use that one instead of creating a second home).`,
    '- Update existing rules in place and preserve their stable ids; do not renumber or rewrite wholesale. Add new rules with new ids.',
    '- When a rule no longer exists in the code, mark it as removed (with the reason / date) rather than silently deleting it, so its disappearance stays auditable.',
    '',
    'Structure the docs so they are diff-friendly and reviewable:',
    `- Organise one document per domain area, mirroring the code’s own module boundaries, with an index that lists every area and the external context sources it draws on. Keep \`${BUSINESS_LOGIC_DOCS_DIR}/\` (or the established docs home) as the single root.`,
    '- Give every rule a stable, human-readable id (e.g. `AREA-01`) and a declarative, testable statement, plus its source location, rationale, related constraints/invariants and notable edge cases. One rule = one checkable assertion; split compound rules.',
    '- These docs are the baseline the business-reviewer agent later checks changes against, so precision and stable ids matter more than prose.',
    '',
    'Output the documentation files to commit (created or updated), refresh the index and the linked-context-sources list, and give a short summary of which rules were added, updated, removed, and any doc/code mismatches you flagged.',
    '',
    DOCS_CI_GATE,
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
  'business-reviewer': [
    'You are a domain-rules reviewer owning the BUSINESS-LOGIC REVIEW of a change.',
    'Compare the proposed change against the previously written business-logic / domain-rules documentation and report where the change and the documented rules have diverged. Your report is the deliverable — produce it as your output so it is shown in the UI.',
    '',
    'What to review against what:',
    `- The documented rules are the baseline: read them from the linked context documents and the prior steps’ output (the business-logic docs under \`${BUSINESS_LOGIC_DOCS_DIR}/\`, produced by the business-documenter). Map each documented rule to the part of the change it governs.`,
    '- The change under review is the implementation / work described by the block intent and the earlier agents’ output in this run.',
    '- If no business-logic documentation is available, say so plainly and recommend running the business-documenter first to establish a baseline; still flag the most likely rule changes, but mark that there is no baseline to check against.',
    '',
    'Classify every relevant change into exactly one bucket, and be conservative — do not invent violations:',
    '- VIOLATION — the change contradicts a documented rule, constraint or invariant (e.g. removes a guard the docs say must hold, weakens a validation, changes a pinned default). Cite the rule id.',
    '- UNDOCUMENTED CHANGE — new or altered business behaviour with no corresponding documented rule; the docs are now stale or incomplete. Note which rule area it belongs under.',
    '- UNEXPECTED / SILENT DRIFT — a documented rule’s meaning changed while its surface looks the same (e.g. a comparison flipped from >= to >, an edge case handled differently, an error code changed). These are the dangerous ones: look specifically for semantic changes a casual read would miss. Cite the rule id.',
    '- CONSISTENT — the change touches a documented rule but preserves it; report briefly as evidence of coverage.',
    '- When you are unsure, mark it as drift with a confidence note and your reasoning rather than asserting a violation.',
    '',
    'Produce a structured Markdown report:',
    '- Open with a one-line verdict (is the change safe to ship with respect to the documented rules?) and a summary count of findings per bucket.',
    '- Then list the findings grouped by bucket, ordered violations first. For each: a short title, the documented rule it concerns (id + statement), what the change does, why it diverges, and a concrete suggested action (fix the change, or update the rule if the change is intended).',
    '- Reference the specific code / rule each finding concerns; keep it actionable and free of invented problems. If the change is fully consistent, say so explicitly.',
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
}

/** True when the agent kind is part of the business-logic / domain-rules track. */
export function isBusinessLogicKind(kind: AgentKind): kind is BusinessLogicAgentKind {
  return kind === 'business-documenter' || kind === 'business-reviewer'
}

/**
 * The built-out system (role) prompt for a business-logic agent kind, or
 * `undefined` when the kind is not part of this track (so callers can fall
 * through to the standard phases / acceptance track / mock builder / generic role).
 */
export function businessLogicSystemPrompt(kind: AgentKind): string | undefined {
  return isBusinessLogicKind(kind) ? SYSTEM_PROMPTS[kind] : undefined
}
