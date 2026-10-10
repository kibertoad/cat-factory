import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { SandboxFixture } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import { builtinFixture, builtinFixturesFor, toSandboxFixture } from '@cat-factory/sandbox-fixtures'
import { SANDBOX_AGENT_KINDS, sandboxKindMeta } from '@cat-factory/sandbox'
import { describe, expect, it } from 'vitest'
import { renderFixtureInput } from './sandbox-input.js'

const registry = defaultAgentKindRegistry()
const NOW = 1_700_000_000_000

/** The wire fixture for a builtin id (what the run-driver actually holds). */
function fixture(id: string): SandboxFixture {
  const def = builtinFixture(id)
  if (!def) throw new Error(`no builtin fixture ${id}`)
  return toSandboxFixture(def, NOW)
}

function render(id: string, agentKind: string): string {
  return renderFixtureInput(fixture(id), sandboxKindMeta(agentKind)!, registry)
}

describe('renderFixtureInput', () => {
  it('sends the requirements reviewer the prompt production sends, output contract included', () => {
    const input = render('req-notify-prefs-simple', 'requirements-review')
    // The three things the hand-rolled renderer dropped, and each of them is scored by the rubric:
    // the JSON output shape, the product-scope test, and the autoAnswerable classification.
    expect(input).toContain('Here are the collected requirements to review')
    expect(input).toContain('"autoAnswerable"')
    expect(input).toContain('PRODUCT / BUSINESS question')
    expect(input).toContain('Notification preferences')
  })

  it('tells the reviewer not to pick a product when the fixture states none, and stays quiet when it does', () => {
    // `buildReviewPrompt` branches on this, so the two fixtures genuinely pose different tasks.
    expect(render('req-notify-prefs-simple', 'requirements-review')).toContain(
      'does not identify which system',
    )
    const identified = render('req-bulk-invite-moderate', 'requirements-review')
    expect(identified).not.toContain('does not identify which system')
    expect(identified).toContain('Workspaces')
  })

  it('sends the clarity reviewer its own triage prompt, with the investigation when present', () => {
    expect(render('clarity-slow-page-simple', 'clarity-review')).toContain(
      'bug report to triage for fixability',
    )
    expect(render('clarity-data-loss-complex', 'clarity-review')).toContain(
      'Investigation (read-only findings from the codebase)',
    )
  })

  it('sends the requirement writer one line per finding plus its grounding, in precedence order', () => {
    const input = render('writer-sla-credits-complex', 'requirements-writer')
    expect(input).toContain('Recommend an answer for each of these requirements-review findings')
    expect(input).toContain('itemId: credit-scale')
    expect(input).toContain('itemId: eligibility')
    // Standards are checked FIRST and the spec excerpts after, which is the ordering the Writer's
    // `groundedIn` precedence rule refers to.
    expect(input.indexOf('BEST-PRACTICE STANDARDS')).toBeLessThan(
      input.indexOf('IN-REPO SPECIFICATIONS'),
    )
    expect(input).toContain('std-sla-credits')
  })

  it('renders the code reviewer through the production user prompt', () => {
    const input = render('review-token-bucket-simple', 'reviewer')
    expect(input).toContain('Per-IP rate limiter')
    expect(input).toContain('counts.get(ip)')
  })

  it('states the absent checkout to a container kind the Sandbox runs inline', () => {
    // The `reviewer`'s composed SYSTEM prompt tells it to diff the branch and read the changed
    // files, because in production it holds a real clone. Saying nothing would grade it on failing
    // to do something impossible.
    const reviewer = render('review-settings-cache-multifile-complex', 'reviewer')
    expect(reviewer).toContain('EVALUATION NOTE')
    expect(reviewer).toContain('NO repository checkout')
    // ...and an inline kind must NOT get the notice: nothing in its prompt ever promised a checkout,
    // so the note would be pure confusion.
    expect(render('req-notify-prefs-simple', 'requirements-review')).not.toContain(
      'EVALUATION NOTE',
    )
    expect(render('arch-avatar-storage-simple', 'architect-companion')).not.toContain(
      'EVALUATION NOTE',
    )
  })

  it('names the system the work belongs to, and STATES the absence when the fixture names none', () => {
    // Production's `AgentContextBuilder` sets `ownService` on every dispatch and
    // `ownServiceSection` renders the "no service" case rather than omitting it, because a bare
    // task title names no software and a silent omission reads like a task whose product is
    // obvious. Left unset here, these three kinds were graded on a prompt production never sends,
    // and a model that invented a product was docked for a hole the harness created.
    const stated = render('review-settings-cache-multifile-complex', 'reviewer')
    expect(stated).toContain('The system this work belongs to: Settings API')
    for (const [fixtureId, kind] of [
      ['review-token-bucket-simple', 'reviewer'],
      ['arch-avatar-storage-simple', 'architect-companion'],
      ['estimate-currency-rounding-moderate', 'task-estimator'],
    ] as const) {
      expect(render(fixtureId, kind), fixtureId).toContain('NOT STATED')
    }
  })

  it('composes the user prompt for the CATALOG kind, never the one the payload claims', () => {
    // The system prompt is composed from `meta.agentKind`. A payload naming a different kind (or
    // naming none, which used to default to `reviewer`) would pair one kind's task framing with
    // another's instructions, which is the "silently grade a different task" the module rules out.
    const authored = fixture('arch-avatar-storage-simple')
    const lying: SandboxFixture = {
      ...authored,
      payload: { ...authored.payload, agentKind: 'reviewer' },
    }
    const input = renderFixtureInput(lying, sandboxKindMeta('architect-companion')!, registry)
    // The companion pointer names the step under review, and for the architect-companion that is
    // the `architect` output, not a coder's.
    expect(input).toContain('`architect` step')
    expect(input).not.toContain('`coder` step')
  })

  it('carries the whole multi-file diff into the prompt', () => {
    const input = render('review-settings-cache-multifile-complex', 'reviewer')
    // Every file of the change has to arrive, because four of that fixture's findings need two files
    // read together. A truncated fold would make them unfindable and the cell would grade the
    // harness rather than the model.
    for (const marker of [
      'src/cache/settingsCache.ts',
      'src/services/SettingsService.ts',
      'src/http/SettingsController.ts',
      'migrations/0042_add_settings_cached.sql',
      'src/cache/settingsCache.test.ts',
      'structuredClone',
      'ADD COLUMN last_read_at',
    ]) {
      expect(input, `missing ${marker}`).toContain(marker)
    }
  })

  it('renders the estimator with the upstream steps’ output it triages from', () => {
    const input = render('estimate-currency-rounding-moderate', 'task-estimator')
    expect(input).toContain('Round monetary totals half-up')
    expect(input).toContain('half-up applies to all currencies')
  })

  it('refuses a payload with nothing to work on rather than grading an empty task', () => {
    // The old tolerant renderer produced an EMPTY prompt here, the cell ran, the judge was told
    // "(no task input was supplied)", and it graded anyway: a real-looking score for a task nobody
    // posed. A workspace can author a payload by hand, so this is reachable.
    const empty: SandboxFixture = { ...fixture('req-notify-prefs-simple'), payload: {} }
    expect(() =>
      renderFixtureInput(empty, sandboxKindMeta('requirements-review')!, registry),
    ).toThrow(ValidationError)
  })

  it('refuses a writer fixture with no findings', () => {
    const noFindings: SandboxFixture = {
      ...fixture('writer-session-timeout-simple'),
      payload: { block: { title: 'Something', type: 'service', description: 'x' }, findings: [] },
    }
    expect(() =>
      renderFixtureInput(noFindings, sandboxKindMeta('requirements-writer')!, registry),
    ).toThrow(ValidationError)
  })

  it('builds a non-empty input for every builtin fixture of every runnable catalog kind', () => {
    // The structural guard, and the one existing tests structurally cannot make: a kind added to the
    // catalog as runnable with no builder refuses every cell at launch, which is a 400 on a surface
    // that offered the kind. Derived from the catalog and the fixture library rather than a hand
    // list, so a new kind or a new fixture is covered with no second edit here.
    const runnable = SANDBOX_AGENT_KINDS.filter((meta) => meta.sandboxRun === 'inline')
    expect(runnable.length).toBeGreaterThan(0)
    for (const meta of runnable) {
      const defs = builtinFixturesFor(meta.agentKind)
      expect(defs.length, `${meta.agentKind} has no builtin fixture`).toBeGreaterThan(0)
      for (const def of defs) {
        const input = renderFixtureInput(toSandboxFixture(def, NOW), meta, registry)
        expect(input.trim().length, `${def.id} rendered an empty input`).toBeGreaterThan(0)
      }
    }
  })

  it('refuses a kind the catalog cannot run rather than rendering something for it', () => {
    const coder = sandboxKindMeta('coder')!
    expect(coder.sandboxRun).toBe('unsupported')
    expect(() => renderFixtureInput(fixture('req-notify-prefs-simple'), coder, registry)).toThrow(
      ValidationError,
    )
  })
})
