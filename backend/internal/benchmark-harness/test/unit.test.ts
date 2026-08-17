import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
  PROMPT_VERSIONS,
} from '@cat-factory/agents'
import type { ModelProvider } from '@cat-factory/kernel'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { writeRunArtifacts } from '../src/artifacts'
import { resolvePiEndpoint } from '../src/endpoints'
import { NodeModelProvider } from '../src/model-provider'
import { defaultVariant, resolvePromptVariant } from '../src/prompt-registry'
import { buildReport } from '../src/report'
import { rubricFor, weightedTotal } from '../src/rubrics'
import { runBenchmark } from '../src/run'
import { type CandidateResult, type CellKey, cellId, type GradesFile } from '../src/types'

// A model provider that returns a fixed completion — lets the runners be driven
// fully offline.
function fakeProvider(text: string): ModelProvider {
  const model: LanguageModel = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      // V3 doGenerate usage is nested; generateText flattens it to
      // `usage.inputTokens` (= 11) / `usage.outputTokens` (= 22).
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 22, text: 22, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  return { resolve: () => model }
}

/**
 * {@link fakeProvider} plus a record of what each call was actually prompted with, so a test can
 * check that the prompt a cell CLAIMS to have used is the one the model saw. The whole message
 * array is stringified rather than the system message picked out of it: the assertion only needs
 * "this text reached the model", and digging into the SDK's message shape would tie the test to a
 * detail the harness does not own.
 */
function recordingProvider(text: string, seen: string[]): ModelProvider {
  const model: LanguageModel = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push(JSON.stringify(options.prompt))
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 22, text: 22, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  return { resolve: () => model }
}

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cat-bench-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('prompt versioning', () => {
  // The resolver exists to make a report's attribution true: the `id@vN` a cell records must
  // name the prompt text that actually ran. So these exercise the RULES that produce that pair.
  // The version DIGIT is not one of them — pinning `build@v3` asserted nothing about the
  // resolver and merely rotted two releases behind the registry.

  it('pairs a built-in prompt with the version from its own registry entry', () => {
    const builtin = PROMPT_VERSIONS.build
    const r = resolvePromptVariant(defaultVariant('build'))
    expect(r.system).toBe(builtin.text)
    expect(r.label).toBe(`build@v${builtin.version}`)
  })

  // The default benchmark path builds `{promptId}` with NO version (see `variantsFor`), so this
  // fallback is what every un-configured run rides. Losing it does not fail anything visibly:
  // cells keep resolving, they just all label `@v1` while running the current prompt, and the
  // whole report silently attributes its numbers to a prompt that never ran.
  it('falls back to the registry version when the variant names none', () => {
    const r = resolvePromptVariant({ promptId: 'build' })
    expect(r.label).toBe(`build@v${PROMPT_VERSIONS.build.version}`)
    expect(r.system).toBe(PROMPT_VERSIONS.build.text)
  })

  it('honours an experimental variant override + version', () => {
    const r = resolvePromptVariant({
      promptId: 'review',
      version: 2,
      system: 'Be terse.',
      temperature: 0.5,
    })
    expect(r.label).toBe('review@v2')
    expect(r.system).toBe('Be terse.')
    expect(r.temperature).toBe(0.5)
  })

  it('lets an explicit label win over the computed one', () => {
    const r = resolvePromptVariant({
      promptId: 'review',
      version: 2,
      system: 'Be terse.',
      label: 'terse-experiment',
    })
    expect(r.label).toBe('terse-experiment')
  })

  it('versions an unknown prompt id at v1 when the variant brings its own text', () => {
    const r = resolvePromptVariant({ promptId: 'house-style', system: 'Be terse.' })
    expect(r.label).toBe('house-style@v1')
    expect(r.system).toBe('Be terse.')
  })

  // The alternative — resolving to an empty system prompt — would run the whole matrix against
  // a typo'd id and report the scores as if they meant something.
  it('refuses an unknown prompt id with no text of its own', () => {
    expect(() => resolvePromptVariant({ promptId: 'house-style' })).toThrow(/house-style/)
  })
})

describe('rubrics', () => {
  it('weights dimensions (build weights: 3+3+2+1+1)', () => {
    const scores = [
      { key: 'faithfulness', score: 5 },
      { key: 'correctness', score: 4 },
      { key: 'completeness', score: 3 },
      { key: 'scope_discipline', score: 2 },
      { key: 'code_quality', score: 1 },
    ]
    // (5*3 + 4*3 + 3*2 + 2*1 + 1*1) / 10 = 36/10
    expect(weightedTotal('implementation', scores)).toBe(3.6)
    expect(rubricFor('implementation').dimensions).toHaveLength(5)
  })
})

describe('cellId', () => {
  it('is filesystem-safe and stable', () => {
    const cell: CellKey = {
      task: 'code-review',
      fixtureId: 'fx',
      modelLabel: 'workers-ai:@cf/x',
      model: 'workers-ai:@cf/x',
      prompt: 'review@v1',
      variant: 'review@v1',
    }
    expect(cellId(cell)).toBe('code-review__fx__workers-ai-cf-x__review-v1')
  })
})

describe('endpoints', () => {
  it('maps Workers AI to the Cloudflare REST OpenAI-compatible endpoint', () => {
    const ep = resolvePiEndpoint({ provider: 'workers-ai', model: '@cf/x' }, undefined, {
      CF_ACCOUNT_ID: 'acct123',
    } as NodeJS.ProcessEnv)
    expect(ep.baseUrl).toContain('/accounts/acct123/ai/v1')
    expect(ep.keyEnv).toBe('CF_API_TOKEN')
  })

  it('derives direct-provider endpoints', () => {
    const ep = resolvePiEndpoint({ provider: 'deepseek', model: 'deepseek-chat' }, undefined, {})
    expect(ep.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(ep.keyEnv).toBe('DEEPSEEK_API_KEY')
  })

  it('reaches every provider the shared table knows, honouring a base-URL override', () => {
    // Derived from the shared table rather than a list here: the harness kept its own copy of the
    // provider→URL map, so a vendor added (or a regional endpoint moved) upstream left benchmarks
    // dialling a stale host or refusing the provider outright.
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      const env = { [`${provider.toUpperCase()}_BASE_URL`]: 'https://stub.internal/v1' }
      const ep = resolvePiEndpoint({ provider, model: 'm' }, undefined, env)
      expect(ep).toEqual({
        baseUrl: 'https://stub.internal/v1',
        keyEnv: `${provider.toUpperCase()}_API_KEY`,
      })
    }
  })

  it('separates "Pi cannot speak to it" from "the gateway URL is unset"', () => {
    expect(() => resolvePiEndpoint({ provider: 'anthropic', model: 'claude-x' }, undefined, {})) //
      .toThrow(/not reached over an OpenAI-compatible endpoint/)
    for (const gateway of OPERATOR_HOSTED_GATEWAYS) {
      expect(() => resolvePiEndpoint({ provider: gateway, model: 'm' }, undefined, {})).toThrow(
        new RegExp(`${gateway.toUpperCase()}_BASE_URL`),
      )
    }
  })
})

describe('NodeModelProvider', () => {
  it('throws a clear error when a required key is missing', () => {
    const p = new NodeModelProvider({ env: {} as NodeJS.ProcessEnv })
    expect(() => p.resolve({ provider: 'anthropic', model: 'claude-x' })).toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })
})

describe('runBenchmark', () => {
  it('runs requirement-review + code-review with a fake model and records exact model/prompt', async () => {
    const reviewJson = JSON.stringify({
      items: [
        { category: 'gap', severity: 'high', title: 'Link expiry', detail: 'How long valid?' },
      ],
    })
    const results = await runBenchmark({
      config: {
        tasks: ['requirement-review', 'code-review'],
        models: [{ ref: { provider: 'workers-ai', model: '@cf/test' } }],
      },
      provider: fakeProvider(reviewJson),
      env: {} as NodeJS.ProcessEnv,
    })
    expect(results).toHaveLength(2)
    const rr = results.find((r) => r.cell.task === 'requirement-review')!
    expect(rr.error).toBeUndefined()
    expect(rr.cell.model).toBe('workers-ai:@cf/test')
    // Shape, not digit: the contract `CellKey.prompt` carries is "the exact prompt version,
    // `id@vN`", for the prompt this task routes to. Which N is the registry's business, and
    // asserting it here only guarantees the test needs editing on every prompt bump.
    expect(rr.cell.prompt).toMatch(/^requirement-review@v\d+$/)
    expect(rr.output).toContain('Link expiry')
    // The requirement-review runner now also reports provider cache hits (0 here — the
    // fake model serves no cached tokens), so the caching dimension can be measured.
    expect(rr.usage).toEqual({ inputTokens: 11, outputTokens: 22, cachedInputTokens: 0 })
    const cr = results.find((r) => r.cell.task === 'code-review')!
    expect(cr.cell.prompt).toMatch(/^review@v\d+$/)
    expect(cr.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
    expect(cr.output).toContain(reviewJson)
    // Cost is metered from the usage via core pricing.
    expect(cr.costEur).toBeGreaterThan(0)
  })

  // The attribution claim end-to-end, and the only way to test it without restating the
  // resolver: the expected label is one the TEST chose, so it cannot be satisfied by recomputing
  // whatever the implementation happens to produce. A harness that ran the built-in prompt while
  // labelling cells with the configured variant would compare two things that never differed.
  it('runs the configured variant and labels the cell with it, not the built-in default', async () => {
    const sentinel = 'SENTINEL-VARIANT-SYSTEM-PROMPT'
    const seen: string[] = []
    const results = await runBenchmark({
      config: {
        tasks: ['requirement-review'],
        models: [{ ref: { provider: 'workers-ai', model: '@cf/test' } }],
        prompts: {
          'requirement-review': [{ promptId: 'requirement-review', version: 99, system: sentinel }],
        },
      },
      provider: recordingProvider(JSON.stringify({ items: [] }), seen),
      env: {} as NodeJS.ProcessEnv,
    })
    expect(results).not.toHaveLength(0)
    expect(seen.join('\n')).toContain(sentinel)
    for (const r of results) expect(r.cell.prompt).toBe('requirement-review@v99')
  })

  it('captures runner failures as error cells rather than throwing', async () => {
    const results = await runBenchmark({
      config: {
        tasks: ['requirement-review'],
        models: [{ ref: { provider: 'anthropic', model: 'claude-x' } }],
      },
      env: {} as NodeJS.ProcessEnv, // no ANTHROPIC_API_KEY -> resolve throws
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.error).toMatch(/ANTHROPIC_API_KEY/)
  })
})

describe('artifacts + report', () => {
  it('writes grading artifacts and merges grades.json into the report', async () => {
    const outDir = await makeTmp()
    const cell: CellKey = {
      task: 'requirement-review',
      fixtureId: 'fx',
      modelLabel: 'm',
      model: 'workers-ai:@cf/test',
      prompt: 'requirement-review@v1',
      variant: 'requirement-review@v1',
    }
    const result: CandidateResult = {
      id: cellId(cell),
      cell,
      input: 'some requirements',
      output: '- [high/gap] Something\n  detail',
      latencyMs: 5,
      usage: { inputTokens: 10, outputTokens: 20 },
      costEur: 0.001,
    }
    const manifest = await writeRunArtifacts({
      outDir,
      runId: 'r1',
      config: { models: [] },
      results: [result],
    })
    expect(manifest.models).toEqual(['workers-ai:@cf/test'])
    expect(manifest.prompts).toEqual(['requirement-review@v1'])

    const gradingDoc = await readFile(join(outDir, 'grading', `${result.id}.md`), 'utf8')
    expect(gradingDoc).toContain('Model (exact):** workers-ai:@cf/test')
    expect(gradingDoc).toContain('gap_coverage')

    const grades: GradesFile = {
      runId: 'r1',
      grades: [
        {
          id: result.id,
          task: 'requirement-review',
          model: cell.model,
          prompt: cell.prompt,
          variant: cell.variant,
          scores: [
            { key: 'gap_coverage', score: 4, rationale: 'ok' },
            { key: 'specificity', score: 5, rationale: 'ok' },
            { key: 'no_hallucination', score: 5, rationale: 'ok' },
            { key: 'severity_calibration', score: 4, rationale: 'ok' },
            { key: 'signal_noise', score: 3, rationale: 'ok' },
          ],
          weightedTotal: 4.4,
        },
      ],
    }
    await writeFile(join(outDir, 'grades.json'), JSON.stringify(grades), 'utf8')
    const rows = await buildReport(outDir, 'r1')
    expect(rows[0]!.score).toBe(4.4)
    const reportMd = await readFile(join(outDir, 'report.md'), 'utf8')
    expect(reportMd).toContain('requirement-review')
    expect(reportMd).toContain('4.40')
  })
})
