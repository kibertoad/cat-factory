import type {
  AnalystRecipeDraft,
  ProvisioningRecommendation,
  StackRecipe,
} from '@cat-factory/contracts'
import { mergeAnalystRecipeDraft } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'

// The pure analyst draft-merge lives in @cat-factory/contracts (beside the types it merges) but
// is exercised here beside the detector it pairs with — the same pattern by which
// `buildFrontendRunNotes` (contracts) is unit-tested from a consuming package. It backs the
// setup wizard's "review recipe" step: detector facts win where both produce a field, analyst-only
// fields fill the gaps, each populated field carrying the winning source's provenance.

/** A minimal detected recommendation carrying a compose recipe + per-field detector notes. */
function recommendation(
  recipe: StackRecipe | undefined,
  notes: ProvisioningRecommendation['notes'] = [],
): ProvisioningRecommendation {
  return {
    detected: true,
    provisioning: {
      type: 'docker-compose',
      composePath: 'docker-compose.yml',
      ...(recipe ? { recipe } : {}),
    },
    notes,
  }
}

describe('mergeAnalystRecipeDraft', () => {
  it('returns the detector recipe verbatim with detector provenance when no draft ran', () => {
    const rec = recommendation(
      { composeFiles: ['dev.yml', 'dev.override.yml'], externalNetworks: ['acme-net'] },
      [
        { field: 'composeFiles', confidence: 'high', message: 'dev.yml + sibling override' },
        {
          field: 'externalNetworks',
          confidence: 'high',
          message: 'external: true network acme-net',
        },
      ],
    )

    const merged = mergeAnalystRecipeDraft(rec)

    expect(merged.recipe).toEqual({
      composeFiles: ['dev.yml', 'dev.override.yml'],
      externalNetworks: ['acme-net'],
    })
    expect(merged.fields).toEqual([
      {
        field: 'composeFiles',
        origin: 'detector',
        confidence: 'high',
        detectorMessage: 'dev.yml + sibling override',
      },
      {
        field: 'externalNetworks',
        origin: 'detector',
        confidence: 'high',
        detectorMessage: 'external: true network acme-net',
      },
    ])
    expect(merged.analystNotes).toEqual([])
    expect(merged.summary).toBeUndefined()
    expect(merged.hasAnalystInput).toBe(false)
  })

  it('returns an empty recipe when neither the detector nor an absent draft produced a field', () => {
    const merged = mergeAnalystRecipeDraft(recommendation(undefined))

    expect(merged.recipe).toEqual({})
    expect(merged.fields).toEqual([])
    expect(merged.hasAnalystInput).toBe(false)
  })

  it('fills analyst-only fields (setup steps, health gate, prerequisites) beside detector facts', () => {
    const rec = recommendation(
      { composeFiles: ['docker/dev.yml'], envFiles: [{ template: '.env.dist', target: '.env' }] },
      [{ field: 'composeFiles', confidence: 'high', message: 'base compose file' }],
    )
    const draft: AnalystRecipeDraft = {
      summary: 'Symfony monolith brought up via composer install then Doctrine migrations.',
      recipe: {
        setupSteps: [
          {
            kind: 'compose-exec',
            name: 'composer install',
            service: 'app',
            command: ['composer', 'install'],
          },
        ],
        healthGate: {
          kind: 'compose-exec',
          service: 'app',
          command: ['bin/console', 'monitor:health'],
        },
        prerequisites: [{ check: 'docker-daemon' }],
      },
      notes: [
        {
          field: 'setupSteps',
          rationale: 'bin/dev-console runs composer install before migrations',
          citations: [{ path: 'bin/dev-console', lines: '112-118' }],
        },
        { field: 'healthGate', rationale: 'health loop calls monitor:health' },
      ],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    // Detector facts preserved; analyst-only fields added.
    expect(merged.recipe).toEqual({
      composeFiles: ['docker/dev.yml'],
      envFiles: [{ template: '.env.dist', target: '.env' }],
      setupSteps: [
        {
          kind: 'compose-exec',
          name: 'composer install',
          service: 'app',
          command: ['composer', 'install'],
        },
      ],
      healthGate: {
        kind: 'compose-exec',
        service: 'app',
        command: ['bin/console', 'monitor:health'],
      },
      prerequisites: [{ check: 'docker-daemon' }],
    })
    // Field order follows MERGEABLE_RECIPE_FIELDS: composeFiles, envFiles, prerequisites, setupSteps, healthGate.
    expect(merged.fields.map((f) => [f.field, f.origin])).toEqual([
      ['composeFiles', 'detector'],
      ['envFiles', 'detector'],
      ['prerequisites', 'analyst'],
      ['setupSteps', 'analyst'],
      ['healthGate', 'analyst'],
    ])

    const setup = merged.fields.find((f) => f.field === 'setupSteps')!
    expect(setup.analystRationale).toBe('bin/dev-console runs composer install before migrations')
    expect(setup.citations).toEqual([{ path: 'bin/dev-console', lines: '112-118' }])

    // envFiles was detected but has no detector note ⇒ no confidence/message attached.
    const envFiles = merged.fields.find((f) => f.field === 'envFiles')!
    expect(envFiles.confidence).toBeUndefined()
    expect(envFiles.detectorMessage).toBeUndefined()

    // prerequisites came from the analyst but carries no matching note ⇒ no rationale attached.
    const prereq = merged.fields.find((f) => f.field === 'prerequisites')!
    expect(prereq.analystRationale).toBeUndefined()
    expect(prereq.citations).toBeUndefined()

    expect(merged.summary).toBe(
      'Symfony monolith brought up via composer install then Doctrine migrations.',
    )
    expect(merged.analystNotes).toHaveLength(2)
    expect(merged.hasAnalystInput).toBe(true)
  })

  it('lets the detector win an overlapping field, marking it `both` and keeping the analyst note out of band', () => {
    const rec = recommendation({ composeFiles: ['detected.yml'] }, [
      { field: 'composeFiles', confidence: 'high', message: 'canonical compose file' },
    ])
    const draft: AnalystRecipeDraft = {
      recipe: { composeFiles: ['analyst-guess.yml'] },
      notes: [{ field: 'composeFiles', rationale: 'README mentions analyst-guess.yml' }],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    // The detector's compose truth wins over the analyst's README-derived guess.
    expect(merged.recipe.composeFiles).toEqual(['detected.yml'])
    const field = merged.fields.find((f) => f.field === 'composeFiles')!
    expect(field.origin).toBe('both')
    expect(field.confidence).toBe('high')
    expect(field.detectorMessage).toBe('canonical compose file')
    // The winning source is the detector, so the analyst rationale is NOT applied to the field…
    expect(field.analystRationale).toBeUndefined()
    // …but it survives verbatim in analystNotes for the wizard to surface as a dissent.
    expect(merged.analystNotes).toEqual([
      { field: 'composeFiles', rationale: 'README mentions analyst-guess.yml' },
    ])
    expect(merged.hasAnalystInput).toBe(true)
  })

  it('uses the analyst recipe wholesale when the detector produced no recipe', () => {
    const rec = recommendation(undefined)
    const draft: AnalystRecipeDraft = {
      recipe: {
        composeFiles: ['compose.yml'],
        setupSteps: [{ kind: 'copy-file', name: 'seed env', from: '.env.dist', to: '.env' }],
      },
      notes: [{ field: 'composeFiles', rationale: 'only compose file in repo root' }],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    expect(merged.recipe).toEqual({
      composeFiles: ['compose.yml'],
      setupSteps: [{ kind: 'copy-file', name: 'seed env', from: '.env.dist', to: '.env' }],
    })
    expect(merged.fields.every((f) => f.origin === 'analyst')).toBe(true)
    const composeFiles = merged.fields.find((f) => f.field === 'composeFiles')!
    expect(composeFiles.analystRationale).toBe('only compose file in repo root')
  })

  it('maps an indexed analyst note (`setupSteps[1]`) to the top-level field when no exact note exists', () => {
    const rec = recommendation(undefined)
    const draft: AnalystRecipeDraft = {
      recipe: {
        setupSteps: [
          {
            kind: 'compose-exec',
            name: 'install',
            service: 'app',
            command: ['composer', 'install'],
          },
          {
            kind: 'compose-exec',
            name: 'migrate',
            service: 'app',
            command: ['bin/console', 'doctrine:migrate'],
          },
        ],
      },
      notes: [
        {
          field: 'setupSteps[1]',
          rationale: 'migrations follow install',
          citations: [{ path: 'bin/dev-console', lines: '140' }],
        },
      ],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    const setup = merged.fields.find((f) => f.field === 'setupSteps')!
    expect(setup.origin).toBe('analyst')
    expect(setup.analystRationale).toBe('migrations follow install')
    expect(setup.citations).toEqual([{ path: 'bin/dev-console', lines: '140' }])
  })

  it('prefers an exact-field analyst note over an indexed one for the field-level chip', () => {
    const rec = recommendation(undefined)
    const draft: AnalystRecipeDraft = {
      recipe: {
        setupSteps: [
          {
            kind: 'compose-exec',
            name: 'install',
            service: 'app',
            command: ['composer', 'install'],
          },
        ],
      },
      notes: [
        { field: 'setupSteps[0]', rationale: 'per-step note' },
        { field: 'setupSteps', rationale: 'field-level summary of the setup sequence' },
      ],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    const setup = merged.fields.find((f) => f.field === 'setupSteps')!
    expect(setup.analystRationale).toBe('field-level summary of the setup sequence')
  })

  it('treats an empty detector array as "not produced" so a non-empty analyst array wins', () => {
    const rec = recommendation({ composeFiles: ['dev.yml'], composeProfiles: [] })
    const draft: AnalystRecipeDraft = {
      recipe: { composeProfiles: ['backends'] },
      notes: [{ field: 'composeProfiles', rationale: 'backends profile is part of base bring-up' }],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    expect(merged.recipe.composeProfiles).toEqual(['backends'])
    const profiles = merged.fields.find((f) => f.field === 'composeProfiles')!
    expect(profiles.origin).toBe('analyst')
  })

  it('reports analyst input from a summary/notes-only draft with no parseable recipe', () => {
    const rec = recommendation({ composeFiles: ['dev.yml'] }, [
      { field: 'composeFiles', confidence: 'low', message: 'guessed base file' },
    ])
    // The lenient draft schema degrades a malformed recipe to undefined, leaving summary/notes.
    const draft: AnalystRecipeDraft = {
      summary: 'Could not shape a valid recipe, but the repo uses a Makefile bring-up.',
      recipe: undefined,
      notes: [{ field: 'setupSteps', rationale: 'make setup runs the whole sequence' }],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    // No analyst recipe fields ⇒ only the detector's field is populated…
    expect(merged.recipe).toEqual({ composeFiles: ['dev.yml'] })
    expect(merged.fields.map((f) => f.field)).toEqual(['composeFiles'])
    // …but the summary + notes still register as analyst input for the wizard to surface.
    expect(merged.summary).toBe(
      'Could not shape a valid recipe, but the repo uses a Makefile bring-up.',
    )
    expect(merged.analystNotes).toHaveLength(1)
    expect(merged.hasAnalystInput).toBe(true)
  })

  it('does not report analyst input for an empty draft (all fields undefined)', () => {
    const rec = recommendation({ composeFiles: ['dev.yml'] })
    const merged = mergeAnalystRecipeDraft(rec, {
      summary: undefined,
      recipe: undefined,
      notes: undefined,
    })

    expect(merged.hasAnalystInput).toBe(false)
    expect(merged.analystNotes).toEqual([])
    expect(merged.summary).toBeUndefined()
  })

  it('treats a blank summary (empty or whitespace-only) as no input and omits it from the output', () => {
    const rec = recommendation({ composeFiles: ['dev.yml'] })

    const empty = mergeAnalystRecipeDraft(rec, { summary: '', recipe: undefined, notes: undefined })
    expect(empty.hasAnalystInput).toBe(false)
    // The blank summary neither counts as input nor rides along ⇒ the two signals agree.
    expect(empty.summary).toBeUndefined()
    expect('summary' in empty).toBe(false)

    const whitespace = mergeAnalystRecipeDraft(rec, {
      summary: '   ',
      recipe: undefined,
      notes: undefined,
    })
    expect(whitespace.hasAnalystInput).toBe(false)
    expect(whitespace.summary).toBeUndefined()
  })

  it('merges analyst teardownSteps last in field order, carrying its provenance note', () => {
    const rec = recommendation({ composeFiles: ['dev.yml'] }, [
      { field: 'composeFiles', confidence: 'high', message: 'base compose file' },
    ])
    const draft: AnalystRecipeDraft = {
      recipe: {
        teardownSteps: [
          { kind: 'compose-exec', name: 'dump db', service: 'db', command: ['pg_dump', 'app'] },
        ],
      },
      notes: [{ field: 'teardownSteps', rationale: 'snapshot the db before down -v' }],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    expect(merged.recipe.teardownSteps).toEqual([
      { kind: 'compose-exec', name: 'dump db', service: 'db', command: ['pg_dump', 'app'] },
    ])
    // teardownSteps is last in MERGEABLE_RECIPE_FIELDS, so it lands after the detector's composeFiles.
    expect(merged.fields.map((f) => f.field)).toEqual(['composeFiles', 'teardownSteps'])
    const teardown = merged.fields.find((f) => f.field === 'teardownSteps')!
    expect(teardown.origin).toBe('analyst')
    expect(teardown.analystRationale).toBe('snapshot the db before down -v')
  })

  it('maps a dot-path analyst note (`healthGate.url`) to the top-level healthGate field', () => {
    const rec = recommendation(undefined)
    const draft: AnalystRecipeDraft = {
      recipe: { healthGate: { kind: 'http', url: 'http://localhost:8080/health' } },
      notes: [
        {
          field: 'healthGate.url',
          rationale: 'README documents the /health endpoint',
          citations: [{ path: 'README.md', lines: '40' }],
        },
      ],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    const gate = merged.fields.find((f) => f.field === 'healthGate')!
    expect(gate.origin).toBe('analyst')
    expect(gate.analystRationale).toBe('README documents the /health endpoint')
    expect(gate.citations).toEqual([{ path: 'README.md', lines: '40' }])
  })

  it('returns a recipe + notes decoupled from the inputs (an edit to the merge cannot mutate them)', () => {
    const rec = recommendation({ composeFiles: ['detected.yml'] }, [
      { field: 'composeFiles', confidence: 'high', message: 'canonical compose file' },
    ])
    const draft: AnalystRecipeDraft = {
      recipe: {
        setupSteps: [
          {
            kind: 'compose-exec',
            name: 'install',
            service: 'app',
            command: ['composer', 'install'],
          },
        ],
      },
      notes: [
        {
          field: 'setupSteps',
          rationale: 'runs install',
          citations: [{ path: 'Makefile', lines: '1' }],
        },
      ],
    }

    const merged = mergeAnalystRecipeDraft(rec, draft)

    // Mutating the reviewable/editable view model must not reach back into the caller's inputs.
    merged.recipe.composeFiles!.push('injected.yml') // detector-won field
    merged.recipe.setupSteps!.push({ kind: 'copy-file', name: 'x', from: 'a', to: 'b' }) // analyst field
    merged.analystNotes.splice(0, merged.analystNotes.length)

    expect(rec.provisioning.recipe!.composeFiles).toEqual(['detected.yml'])
    expect(draft.recipe!.setupSteps).toHaveLength(1)
    expect(draft.notes).toHaveLength(1)
  })
})
