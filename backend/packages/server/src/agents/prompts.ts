import type { AgentRunContext } from '@cat-factory/kernel'
import { FINAL_ANSWER_IN_REPLY, userPromptFor } from '@cat-factory/agents'
import type { RepoTarget } from './ContainerAgentExecutor.js'

/**
 * The role/system prompts, structured-output shape hints, and per-kind user-prompt
 * builders for the built-in container agent kinds the {@link ContainerAgentExecutor}
 * migrated onto the generic `agent` harness surface (blueprints / spec-writer / merger /
 * on-call / tester). Extracted verbatim from `ContainerAgentExecutor.ts` so the prompt
 * material lives in one cohesive unit; the executor imports it at its original call sites.
 * Pure strings + pure builder functions — no executor state.
 */

/** Role prompt the Blueprinter step's agent runs under (returns the tree as JSON). */
export const BLUEPRINT_SYSTEM_PROMPT =
  'You are a Domain-Driven Design architect mapping this repository. Decompose it ' +
  'into ONE top-level service and the modules inside it, where each module is a ' +
  'DOMAIN — a cohesive area of the BUSINESS, in the language of the problem space ' +
  '(a DDD bounded context / aggregate / subdomain). Name modules after business ' +
  'concepts, not technical layers. ' +
  'A module MUST represent a business capability or domain model (e.g. Billing, ' +
  'Catalog, Ordering, Identity), NOT a technical layer or shape: "api", "routes", ' +
  '"controllers", "utils", "helpers", "lib", "common", "config", "types", "models", ' +
  '"db" and the like are NOT domains and MUST NOT be modules. ' +
  'Group the genuinely non-business, technical/cross-cutting plumbing (persistence ' +
  'wiring, HTTP/transport, logging, configuration, auth middleware, build/deploy, ' +
  'shared utilities) into a SINGLE module named "infrastructure" rather than ' +
  'scattering it into many technical modules. ' +
  'Prefer organising code by domain (the ubiquitous language) over organising by ' +
  'file type. Anchor every node to the codebase with explicit repo-relative ' +
  'file/directory references. Keep names short and descriptive. ' +
  'Respond with ONLY a JSON object of shape {"type","name","summary","references":[],' +
  '"modules":[{"name","summary","references":[]}]} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the spec-writer step runs under (returns the spec doc as JSON). */
export const SPEC_WRITER_SYSTEM_PROMPT =
  'You maintain the PRESCRIPTIVE specification for a service. READ the specification ' +
  'already committed to the repository under `spec/` (the baseline): start with ' +
  '`spec/overview.md` for the module → feature index, then open the relevant ' +
  '`spec/modules/<module>/<feature>.json` shards for the detail you need. You are also ' +
  'given the ' +
  'requirements of ONE task. Apply that task as an INCREMENT onto the baseline: add ' +
  'requirements for what the task introduces, and adjust existing requirements ONLY ' +
  'where the task changes their expected behaviour. Leave every other part of the ' +
  'baseline spec untouched. Translate ONLY what the task requirements state — do NOT ' +
  'invent requirements, fill gaps, or design beyond them (missing requirements are the ' +
  'requirements step’s job, not yours). ' +
  'The spec captures ONLY BUSINESS requirements — externally-observable behaviour, ' +
  'product rules and acceptance criteria. PURELY TECHNICAL work (a refactor, a ' +
  'dependency bump, internal restructuring, build/infra or other non-functional change ' +
  'that does NOT alter what the system does for its users) introduces no business ' +
  'requirements, and "NO NEW SPECS" is a valid, correct outcome for it: do NOT invent ' +
  'requirements to justify a change, and do NOT re-document technical/architecture ' +
  'detail here. When this task is purely technical, leave the baseline spec untouched ' +
  'and respond with ONLY {"noBusinessSpecs": true} (no other fields, no prose, no code ' +
  'fences). Otherwise return the full document as below. ' +
  'The spec is a two-level taxonomy: MODULES ' +
  '(domains, e.g. "Auth") each containing GROUPS (features, e.g. "Login"). Every ' +
  'requirement AND every domain rule lives inside a specific feature group: a group ' +
  'carries both its `requirements` and the `rules` scoped to it. There is NO catch-all — ' +
  'a cross-cutting concern goes in a `common` or `infrastructure` module that is ITSELF ' +
  'split into specific feature groups. CRUCIALLY, reuse the EXISTING taxonomy: place ' +
  'each new requirement/rule into the closest-fitting existing module and feature, ' +
  'reusing its EXACT name, and create a new module or feature ONLY when nothing fits — ' +
  'never a near-duplicate of an existing one (no "Authentication" beside "Auth", no ' +
  '"User Login" beside "Login"). Each requirement is phrased as "The system SHALL …" ' +
  'with a MoSCoW priority (must/should/could) and structured Given/When/Then acceptance ' +
  'criteria. Acceptance-scenario coverage is a FIRST-CLASS deliverable: every ' +
  'requirement the task adds or changes MUST carry complete acceptance criteria — the ' +
  'happy path AND the invalid-input / error / edge / boundary cases the requirements ' +
  'imply — since the Gherkin `.feature` files and the runnable tests are derived ' +
  'mechanically from them. Preserve the baseline’s existing `sourceBlockIds`; tag the ' +
  'requirements this task adds or changes with this task’s block id. Return the ' +
  'COMPLETE updated specification (baseline plus this increment), not a diff. You have ' +
  'NO repository write access and MUST NOT write, edit, or commit any file: the platform ' +
  'persists the specification you return, so returning it IS the whole job. Respond ' +
  'with ONLY a JSON object of ' +
  'shape {"service","summary","modules":[{"name","summary","groups":[{"name","summary",' +
  '"requirements":[{"id","title","statement","kind","priority","sourceBlockIds":[],' +
  '"acceptance":[{"id","given","when","outcome"}]}],"rules":[{"id","rule","rationale",' +
  '"sourceBlockIds":[]}]}]}]} ' +
  '(each acceptance criterion is a Given/When/Then, with the Then clause in `outcome`) — ' +
  'no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the `merger` step runs under (scores the PR; returns JSON only). */
export const MERGER_SYSTEM_PROMPT =
  'You are a release manager assessing a pull request before merge. Inspect the ' +
  'diff between the PR head branch and the base branch and judge three axes, each ' +
  'as a number from 0 (trivial/safe) to 1 (severe): complexity (how intricate the ' +
  'change is), risk (how likely it is to break something), and impact (blast radius ' +
  'if it does). Be conservative. Respond with ONLY a JSON object of shape ' +
  '{"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Compact shape hint fed to the structured-output repair call for the blueprint tree. */
export const BLUEPRINT_SHAPE_HINT =
  'Expected a service tree: {"type": string, "name": string, "summary": string, ' +
  '"references": string[], "modules": [{"name": string, "summary": string, ' +
  '"references": string[]}]}.'

/** Compact shape hint fed to the structured-output repair call for the spec doc. */
export const SPEC_SHAPE_HINT =
  'Expected a requirements document with a two-level taxonomy — module (domain) → ' +
  'group (feature) — where each group carries BOTH its requirements and the domain ' +
  'rules scoped to it: {"service": string, "summary": string, "modules": [{"name": ' +
  'string, "summary": string, "groups": [{"name": string, "summary": string, ' +
  '"requirements": [{"id": string, "title": string, "statement": string, "kind": ' +
  'string, "priority": string, "sourceBlockIds": string[], "acceptance": [{"given": ' +
  'string, "when": string, "outcome": string}]}], "rules": [{"id": string, "rule": ' +
  'string, "rationale": string, "sourceBlockIds": string[]}]}]}]}. For a purely ' +
  'technical task with no business requirements, the document is instead just ' +
  '{"noBusinessSpecs": true}.'

/** Compact shape hint fed to the structured-output repair call for the merger assessment. */
export const MERGE_ASSESSMENT_SHAPE_HINT =
  'Expected a merge assessment: {"complexity": number 0..1, "risk": number 0..1, ' +
  '"impact": number 0..1, "rationale": string}.'

/** Compact shape hint fed to the structured-output repair call for the on-call assessment. */
export const ON_CALL_ASSESSMENT_SHAPE_HINT =
  'Expected an on-call assessment: {"culpritConfidence": number 0..1, "recommendation": ' +
  '"revert"|"hold"|"monitor", "rationale": string, "evidence": string[]}.'

/** Compact shape hint fed to the structured-output repair call for the tester report. */
export const TEST_REPORT_SHAPE_HINT =
  'Expected a test report: {"greenlight": boolean, "summary": string, "tested": string[], ' +
  '"outcomes": [{"name": string, "status": "passed"|"failed"|"skipped", "detail"?: string}], ' +
  '"concerns": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"|"critical"}]}.'

/** Shape hint for the UI tester: a test report that also lists captured screenshots. */
export const UI_TEST_REPORT_SHAPE_HINT =
  TEST_REPORT_SHAPE_HINT.replace(/\}\.$/, '') +
  ', "screenshots": [{"view": string, "artifactId": string, "hash"?: string}]}. Each ' +
  'screenshot must be a distinct view you captured and uploaded to the artifact store.'

export const ON_CALL_SYSTEM_PROMPT =
  'You are an on-call engineer investigating a possible post-release regression. A ' +
  'recently merged pull request shipped, and the evidence below (alerting Datadog ' +
  'monitors/SLOs and recent error logs) suggests the service regressed afterward. Read ' +
  'the PR diff on the head branch and weigh whether THIS change is the likely cause — ' +
  'beware correlation vs causation; a coincident deploy is not proof. You may read and ' +
  'inspect any file, but you MUST NOT modify, commit or revert anything; a human decides ' +
  'whether to revert. Respond with ONLY a JSON object of shape ' +
  '{"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…",' +
  '"evidence":["…"]} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/**
 * The Blueprinter's task prompt. The agent now reads any existing blueprint from its own
 * read-only checkout (the harness no longer pre-injects the baseline tree), so the prompt
 * tells it to read `blueprints/` and update-or-create, then return the complete tree as
 * JSON. The backend `blueprintPostOp` renders + commits the artifact from that tree.
 */
export function blueprintUserPrompt(): string {
  return [
    'Map this repository into the canonical service → modules blueprint, anchored to real ' +
      'file/directory references.',
    '',
    'If a blueprint already exists in the repository (read `blueprints/blueprint.json` and ' +
      '`blueprints/overview.md`), UPDATE it to reflect the current code: keep accurate ' +
      'modules, add new ones, and refine summaries + references. Otherwise create it from ' +
      'scratch. Return the COMPLETE tree (not a diff).',
    '',
    'Respond with ONLY the JSON object for the service tree — no prose, no code fences.',
  ].join('\n')
}

/**
 * The spec-writer's task prompt — the instructions + baseline-read + taxonomy-reuse guidance
 * the bespoke harness `/spec` handler used to build (`buildUserPrompt`/`renderTaxonomyInventory`,
 * which used to inject the baseline doc + its module→feature inventory). The agent now reads
 * the baseline from its own read-only checkout under `spec/`, so the prompt tells it to read +
 * reuse the existing taxonomy rather than pre-injecting it. Carries ONLY this task's
 * requirements (the block description IS the task's reworked/incorporated requirements), so an
 * unmerged sibling task's work never bleeds in. The backend `specPostOp` shards + commits the
 * returned tree.
 */
export function specWriterUserPrompt(context: AgentRunContext): string {
  const block = context.block
  const header = `### ${block.title || '(untitled task)'}${block.id ? ` (block ${block.id})` : ''}`
  // Honour an explicit human-set BUSINESS/TECHNICAL label: a task pinned business HAS
  // business requirements, so the "no new specs" escape hatch is withdrawn; a task pinned
  // technical is told the empty outcome is expected. Left unset, the writer self-determines.
  const technicalGuidance =
    block.technical === false
      ? 'This task is explicitly flagged BUSINESS: it HAS business requirements, so you MUST ' +
        'return the full updated specification. Do NOT respond with {"noBusinessSpecs": true}.'
      : block.technical === true
        ? 'This task is explicitly flagged TECHNICAL (a refactor / dependency bump / internal ' +
          'or non-functional change with NO new externally-observable behaviour): "no business ' +
          'requirements" is the expected outcome — respond with ONLY {"noBusinessSpecs": true} ' +
          'and change nothing, unless you find genuine externally-observable behaviour to spec.'
        : 'If this task is purely TECHNICAL (a refactor / dependency bump / internal or ' +
          'non-functional change that introduces NO new externally-observable behaviour), it ' +
          'has no business requirements: respond with ONLY {"noBusinessSpecs": true} and ' +
          'change nothing.'
  return [
    'Apply this ONE task as an INCREMENT onto the service specification.',
    '',
    'First READ the specification already committed to the repository under `spec/` (the ' +
      'baseline as merged before this task): open `spec/overview.md` for the module → feature ' +
      'index, then the relevant `spec/modules/<module>/<feature>.json` shards. Keep every part ' +
      'of the baseline this task does not touch exactly as-is, preserving its `sourceBlockIds`; ' +
      'adjust an existing requirement only where this task changes its behaviour. Map each new ' +
      'requirement/rule into the closest-fitting EXISTING module and feature, reusing its EXACT ' +
      'name — create a new module or feature ONLY when nothing fits (never a near-duplicate). ' +
      'If no spec exists yet, start one as a module (domain) → feature (group) taxonomy.',
    '',
    'Requirements for the ONE task to apply (its clarified description). Translate ONLY what ' +
      'these state into BUSINESS requirements (externally-observable behaviour, product rules, ' +
      'acceptance criteria) with COMPLETE acceptance-scenario coverage — do NOT invent ' +
      'requirements or fill gaps they leave:',
    '',
    `${header}\n\n${block.description?.trim() || '(no description)'}`,
    '',
    technicalGuidance +
      ' Otherwise return the COMPLETE updated document (baseline plus this task’s ' +
      'increment), not a diff. Respond with ONLY the JSON object — no prose, no code fences.',
  ].join('\n')
}

/**
 * The merger's task prompt — the instructions + diff guidance the bespoke harness `/merge`
 * handler used to build. Kept backend-side now that the merger dispatches the generic
 * explore agent. Names the PR/branches so the agent diffs against the right base.
 */
export function mergerUserPrompt(context: AgentRunContext, repo: RepoTarget): string {
  const prNumber = context.block.pullRequest?.number
  const branch = context.block.pullRequest?.branch ?? repo.baseBranch
  const pr = prNumber !== undefined ? ` (PR #${prNumber})` : ''
  return [
    'Assess the pull request on the head branch against the base branch and return the ' +
      'complexity / risk / impact scores + rationale as JSON.',
    '',
    `The pull request${pr} is on branch \`${branch}\`; the base branch is ` +
      `\`${repo.baseBranch}\`. Inspect the change (e.g. \`git fetch origin ${repo.baseBranch}\` ` +
      `then \`git diff origin/${repo.baseBranch}...HEAD\`) and score complexity, risk and impact.`,
    '',
    'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.',
  ].join('\n')
}

/**
 * The on-call agent's task prompt — the regression evidence (the generic block/prior-output
 * prompt) plus the locate-the-merged-commit guidance the bespoke harness `/on-call` handler
 * used to build. The released PR already merged into the base branch (its work branch is
 * gone), so the agent is on the base branch and is told how to find the merged commit.
 */
export function onCallUserPrompt(context: AgentRunContext, repo: RepoTarget): string {
  const prNumber = context.block.pullRequest?.number
  const headBranch = context.block.pullRequest?.branch
  const pr = prNumber !== undefined ? `#${prNumber}` : ''
  const locate = prNumber
    ? `It merged as a commit referencing ${pr} — find it with \`git log --oneline -n 50\` ` +
      `(squash/merge commits include \`(${pr})\`; a merge commit mentions \`#${prNumber}\`), then ` +
      `inspect it with \`git show <sha>\`.`
    : headBranch
      ? `Its work branch was \`${headBranch}\` (now deleted) — find the merged commit in ` +
        `\`git log --oneline -n 50\` and inspect it with \`git show <sha>\`.`
      : `Find the most recent merge/feature commit with \`git log --oneline -n 50\` and inspect ` +
        `it with \`git show <sha>\`.`
  return [
    userPromptFor(context, { materialized: true }),
    '',
    `You are on the base branch \`${repo.baseBranch}\`, which already contains the released ` +
      `pull request ${pr}. ${locate} Correlate that change with the regression evidence above. ` +
      `Beware correlation vs causation.`,
    '',
    'Respond with ONLY a JSON object {"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…","evidence":["…"]}.',
  ].join('\n')
}

/**
 * The tester's infra stand-up spec for the generic agent job, derived from the service's
 * declared provision type: a `docker-compose` service stands its compose stack up
 * in-container (`environment:'local'` + the compose path); a `kubernetes`/`custom` service
 * runs against the provisioned ephemeral environment URL (`environment:'ephemeral'`); an
 * `infraless` service (or none declared) stands nothing up (`local` + `noInfraDependencies`).
 * The harness `infra` wire shape is unchanged — only its source moved from the old
 * `tester.environment` config to the service's `provisioning`.
 */
export function testerInfraSpec(context: AgentRunContext): Record<string, unknown> {
  const provisioning = context.service?.provisioning
  const type = provisioning?.type
  if (type === 'kubernetes' || type === 'custom') {
    return {
      environment: 'ephemeral',
      ...(context.environment?.url ? { environmentUrl: context.environment.url } : {}),
    }
  }
  return {
    environment: 'local',
    noInfraDependencies: type !== 'docker-compose',
    ...(type === 'docker-compose' && provisioning?.composePath
      ? { composePath: provisioning.composePath }
      : {}),
  }
}

export function prBody(context: AgentRunContext): string {
  const lines = [
    `Automated implementation for block **${context.block.title}** (${context.block.type}).`,
    '',
    context.block.description || '(no description)',
    '',
    `Pipeline: ${context.pipelineName}`,
  ]
  return lines.join('\n')
}
