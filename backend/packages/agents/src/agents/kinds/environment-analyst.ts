import { type AnalystRecipeDraft, analystRecipeDraftSchema } from '@cat-factory/contracts'
import { defineStructuredOutput } from './structured-output.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The `environment-analyst` agent kind — the OPT-IN LLM half of environment auto-detection
// (slice 8 of docs/initiatives/stack-recipes-and-shared-stacks.md).
//
// The deterministic detector (`provision-detect.logic.ts`) reads a repo checkout-free and
// recommends the recipe fields it can see mechanically (compose layering, external networks,
// env-file pairs, seed-dump candidates). It cannot see the IMPERATIVE bring-up encoded in a
// README / Makefile / `bin/*` CLI / setup script (detection never parses shell). This agent
// fills that gap: a read-only `container-explore` kind that clones the repo, reads those files,
// and returns a structured DRAFT `StackRecipe` (setup steps + prerequisites + health gate),
// each grounded in a source citation, on `result.custom`.
//
// It is registered through the public `AgentKindRegistry` seam (the `bug-investigator` /
// `security-auditor` shape) and pre-loaded by `defaultAgentKindRegistry()`. The draft is
// NON-BINDING: the setup wizard (slice 7) merges it over the deterministic recommendation
// (detector facts win where both produce a field; analyst-only fields arrive editable + flagged
// with provenance), and nothing is applied until the human confirms it. So this agent never
// writes the repo (no post-op) — its whole product is the JSON on `result.custom`, rendered by
// the shared `generic-structured` result view.
//
// The read-only guardrail + final-answer-in-reply directives are appended automatically for a
// registered `container-explore` kind (see `applySurfaceDirectives` in `catalog.ts`), so the
// prompt below is only the core role.
// ---------------------------------------------------------------------------

export const ENVIRONMENT_ANALYST_KIND = 'environment-analyst'

/**
 * The analyst's structured draft — a {@link AnalystRecipeDraft} (a proposed `StackRecipe` +
 * per-field provenance + summary). The valibot schema lives in `@cat-factory/contracts` (shared
 * with the wizard); it is LENIENT (`v.fallback`) so a partially-malformed reply degrades
 * field-by-field rather than discarding the whole draft. `failOnUnusableFinal` fails the run
 * loudly when the model returns an EMPTY final answer (a common reasoning-model failure) instead
 * of silently laundering an empty draft — the deliverable IS the JSON. The `shapeHint` is
 * hand-written because the recipe's discriminated-union steps/health-gate walk poorly.
 */
export const environmentRecipeDraft = defineStructuredOutput(analystRecipeDraftSchema, {
  failOnUnusableFinal: true,
  shapeHint:
    '{ "summary": "one paragraph on the repo bring-up", ' +
    '"recipe": { ' +
    '"composeFiles": ["ordered -f layers, base first"], ' +
    '"composeProfiles": ["COMPOSE_PROFILES to enable"], ' +
    '"envFiles": [{ "template": "committed.dist", "target": "gitignored" }], ' +
    '"externalNetworks": ["networks the project expects to pre-exist"], ' +
    '"prerequisites": [{ "check": "docker-daemon|disk-space|memory|registry-auth|tcp-reachable|http-reachable|mkcert-ca|hosts-entries|env-secrets-marker", ' +
    '"params": { "minGib": 0, "registry": "…", "host": "…", "port": 0, "url": "…", "hostnames": ["…"], "file": "…", "marker": "…" }, "required": true }], ' +
    '"setupSteps": [ ' +
    '{ "kind": "compose-exec", "name": "…", "service": "…", "command": ["argv"], "stdinFile": "optional .sql", "timeoutMs": 0 } | ' +
    '{ "kind": "copy-file", "name": "…", "from": "…", "to": "…" } | ' +
    '{ "kind": "wait-http", "name": "…", "url": "…", "expectStatus": 200 } | ' +
    '{ "kind": "wait-file", "name": "…", "path": "…", "service": "optional" } | ' +
    '{ "kind": "host-command", "name": "…", "command": ["argv"] } ], ' +
    '"healthGate": { "kind": "compose-healthy" } | { "kind": "http", "url": "…" } | { "kind": "compose-exec", "service": "…", "command": ["argv"] } }, ' +
    '"notes": [{ "field": "setupSteps[0]", "rationale": "why", "citations": [{ "path": "file", "lines": "112-140", "excerpt": "…" }] }] }',
})

/** The inferred draft type — flows straight from the contract schema, no duplicate interface. */
export type EnvironmentRecipeDraft = AnalystRecipeDraft

const ENVIRONMENT_ANALYST_SYSTEM_PROMPT =
  'You are an environment-setup analyst. A running copy of this repository has been checked out ' +
  'read-only. Your job is to understand how a developer brings this system up locally and express ' +
  'that as a DECLARATIVE Docker Compose stack recipe — a DRAFT a human will review, edit and ' +
  'confirm before anything runs. You never change the repo.\n\n' +
  'Read the imperative bring-up wherever it lives: the README, a Makefile / justfile / Taskfile, a ' +
  'repo CLI under `bin/` (e.g. a `dev-console`/`console` script), Docker Compose files and their OS ' +
  'overrides, `.env*`/`*.dist`/`*.example` templates, database seed dumps, and any setup shell ' +
  'scripts. TRUST THE COMPOSE FILES over prose: a README often drifts from the actual services, ' +
  'image tags and ports — cite the compose file, not the README claim.\n\n' +
  'Translate that bring-up into the recipe, in ORDER:\n' +
  '- `composeFiles`: the ordered `-f` layering (base first, then overrides). Prefer OS-neutral ' +
  'layers; mention an OS-specific override in a note rather than committing to one.\n' +
  '- `composeProfiles`: only profiles that are part of the DEFAULT bring-up (leave optional/opt-in ' +
  'service groups out and note them).\n' +
  '- `envFiles`: each committed template that must be copied to a gitignored target before `up` ' +
  '(`{ template, target }`).\n' +
  '- `externalNetworks`: networks the project attaches to but does not define (an ' +
  '`external: true` network usually means it depends on a separate, long-lived shared stack).\n' +
  '- `prerequisites`: machine checks that must pass before provisioning — one of `docker-daemon`, ' +
  '`disk-space`, `memory`, `registry-auth` (a private registry the images pull from), ' +
  '`tcp-reachable`/`http-reachable` (a VPN-only host), `mkcert-ca`, `hosts-entries`, ' +
  '`env-secrets-marker` (a marker line a secrets step writes into an env file). These cover the ' +
  'inherently-manual one-time setup (VPN / SSO / mkcert / hosts); DECLARE them so the human is ' +
  'guided, do not try to automate them.\n' +
  '- `setupSteps`: the ordered post-`up` work, each a `compose-exec` (install deps, run migrations, ' +
  'warm caches, build indexes, import a seed via `stdinFile`), `copy-file`, `wait-http`, ' +
  '`wait-file`, or (rarely) `host-command`. Commands are an argv array, NOT a shell string.\n' +
  '- `healthGate`: the terminal readiness check (`compose-healthy` when the compose file declares ' +
  'healthchecks, else an `http` poll or a `compose-exec` health command).\n\n' +
  "IMPORTANT: do NOT assume the repo's own CLI can run on this host — many refuse Git-Bash/msys " +
  'and expect Linux/WSL. TRANSLATE the steps that CLI performs into recipe steps; do not emit a ' +
  'step that just shells out to it. For EVERY field and step you draft, add a `notes` entry with a ' +
  'short rationale and a `citations` list (file path + line range) grounding it in what you read. ' +
  'Only include a field when you have real evidence for it — an empty recipe with an honest summary ' +
  'is better than a fabricated one. Return ONLY a JSON object of this exact shape:\n' +
  '{\n' +
  '  "summary": "one paragraph on how this system is brought up",\n' +
  '  "recipe": { "composeFiles": [], "composeProfiles": [], "envFiles": [], "externalNetworks": [], "prerequisites": [], "setupSteps": [], "healthGate": {} },\n' +
  '  "notes": [{ "field": "setupSteps[0]", "rationale": "why", "citations": [{ "path": "bin/dev-console", "lines": "112-140" }] }]\n' +
  '}\n' +
  'Omit any recipe field you found no evidence for (do not emit empty placeholders inside it).'

export const ENVIRONMENT_ANALYST_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: ENVIRONMENT_ANALYST_KIND,
    systemPrompt: ENVIRONMENT_ANALYST_SYSTEM_PROMPT,
    // Read-only checkout of the default branch — the analyst studies the repo AS-IS to draft a
    // recipe; it never edits or opens a PR. `agent.output` is derived from the schema.
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    structuredOutput: environmentRecipeDraft,
    presentation: {
      label: 'Environment Analyst',
      icon: 'i-lucide-container',
      color: '#0ea5e9',
      description:
        'Read-only repo analysis that drafts a declarative Docker Compose stack recipe (setup ' +
        'steps, prerequisites, health gate) for review in the environment setup wizard.',
      category: 'design',
      // The structured draft opens in the shared generic viewer (no bespoke window); the wizard
      // reads it off the step and merges it over the deterministic recommendation.
      resultView: 'generic-structured',
    },
  },
]

/**
 * Register the environment-analyst kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerEnvironmentAnalystAgent(registry: AgentKindRegistry): void {
  registry.registerAll(ENVIRONMENT_ANALYST_AGENT_KINDS)
}
