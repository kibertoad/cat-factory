import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../catalog.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import { ENVIRONMENT_ANALYST_KIND, environmentRecipeDraft } from './environment-analyst.js'
import { READ_ONLY_GUARDRAIL } from './read-only.js'
import { defaultAgentKindRegistry } from './registry.js'

// `defaultAgentKindRegistry()` pre-loads the built-in environment-analyst kind, so a fresh
// instance exposes it (no module-global side effect).
const registry = defaultAgentKindRegistry()

describe('environment-analyst agent kind', () => {
  it('registers a read-only container-explore kind that routes to the container executor', () => {
    const step = registry.agentStep(ENVIRONMENT_ANALYST_KIND)
    expect(step?.surface).toBe('container-explore')
    // Reads the repo AS-IS (default branch); it never edits or opens a PR.
    expect(step?.clone?.branch).toBe('base')
    expect(registry.requiresContainer(ENVIRONMENT_ANALYST_KIND)).toBe(true)
  })

  it('derives the structured output spec from the shared draft schema onto agent.output', () => {
    // The schema is the single source: registerAgentKind spreads structuredOutput.spec onto
    // agent.output, and the hand-written shapeHint + fail-on-unusable flag ride along.
    expect(registry.agentStep(ENVIRONMENT_ANALYST_KIND)?.output).toEqual(
      environmentRecipeDraft.spec,
    )
    expect(environmentRecipeDraft.spec.kind).toBe('structured')
    expect(environmentRecipeDraft.spec.failOnUnusableFinal).toBe(true)
    expect(environmentRecipeDraft.spec.shapeHint).toContain('composeFiles')
    expect(environmentRecipeDraft.spec.shapeHint).toContain('healthGate')
  })

  it('surfaces presentation that opens the generic structured result view', () => {
    const presentation = registry.presentation(ENVIRONMENT_ANALYST_KIND)
    expect(presentation?.label).toBe('Environment Analyst')
    expect(presentation?.category).toBe('design')
    expect(presentation?.resultView).toBe('generic-structured')
  })

  it('does no repo writes (no post-ops) — its whole product is the draft on result.custom', () => {
    expect(registry.postOps(ENVIRONMENT_ANALYST_KIND)).toEqual([])
    expect(registry.preOps(ENVIRONMENT_ANALYST_KIND)).toEqual([])
  })

  it('appends the read-only guardrail + final-answer-in-reply surface directives', () => {
    // Auto-applied for a registered container-explore kind (applySurfaceDirectives), so the
    // analyst never edits and a reasoning model can't lose the draft to its hidden channel.
    const prompt = systemPromptFor(ENVIRONMENT_ANALYST_KIND, registry)
    expect(prompt).toContain(READ_ONLY_GUARDRAIL)
    expect(prompt).toContain(FINAL_ANSWER_IN_REPLY)
    // The core role names the imperative sources it must translate into a recipe.
    expect(prompt).toContain('stack recipe')
    expect(prompt).toContain('healthGate')
  })

  it('parses a well-formed draft (recipe + provenance)', () => {
    const draft = environmentRecipeDraft.parse({
      summary: 'A Symfony monolith brought up via compose + an imperative setup script.',
      recipe: {
        composeFiles: ['docker/dev.yml'],
        externalNetworks: ['acme-net'],
        envFiles: [{ template: '.env.dev.local-dist', target: '.env.dev.local' }],
        setupSteps: [
          {
            kind: 'compose-exec',
            name: 'composer install',
            service: 'app',
            command: ['composer', 'install'],
          },
          {
            kind: 'wait-file',
            name: 'frontend build',
            path: 'public/js/compiled/ui/manifest.json',
          },
        ],
        healthGate: {
          kind: 'compose-exec',
          service: 'app',
          command: ['bin/console', 'monitor:health'],
        },
      },
      notes: [
        {
          field: 'setupSteps[0]',
          rationale: 'The setup script runs composer install inside the app container.',
          citations: [{ path: 'bin/dev-console', lines: '112-140' }],
        },
      ],
    })
    expect(draft.recipe?.composeFiles).toEqual(['docker/dev.yml'])
    expect(draft.recipe?.setupSteps).toHaveLength(2)
    expect(draft.notes?.[0]?.citations?.[0]?.path).toBe('bin/dev-console')
  })

  it('degrades gracefully: a malformed recipe drops only that field, keeping summary + notes', () => {
    // A single bad step would otherwise fail the whole strict recipe parse; the lenient draft
    // schema fallbacks `recipe` to undefined while preserving the analysis the human can read.
    const draft = environmentRecipeDraft.safeParse({
      summary: 'Best-effort summary.',
      recipe: { setupSteps: [{ kind: 'nonsense-step' }] },
      notes: [{ field: 'summary', rationale: 'why' }],
    })
    expect(draft).toBeDefined()
    expect(draft?.recipe).toBeUndefined()
    expect(draft?.summary).toBe('Best-effort summary.')
    expect(draft?.notes?.[0]?.field).toBe('summary')
  })

  it('safeParse never throws on garbage, returning an empty draft', () => {
    const draft = environmentRecipeDraft.safeParse({ recipe: 123, notes: 'nope', summary: 42 })
    expect(draft).toEqual({ summary: undefined, recipe: undefined, notes: undefined })
  })
})
