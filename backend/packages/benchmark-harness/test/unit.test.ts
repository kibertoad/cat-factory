import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel, ModelProvider } from '@cat-factory/core'
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
  return {
    resolve(): LanguageModel {
      return new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          // V3 doGenerate usage is nested; generateText flattens it to
          // `usage.inputTokens` (= 11) / `usage.outputTokens` (= 22).
          usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 22, text: 22, reasoning: 0 },
          },
          warnings: [],
        }),
      }) as unknown as LanguageModel
    },
  }
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
  it('resolves built-in prompts to id@vN with their text', () => {
    const r = resolvePromptVariant(defaultVariant('build'))
    expect(r.label).toBe('build@v1')
    expect(r.system).toContain('senior engineer')
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
})

describe('NodeModelProvider', () => {
  it('throws a clear error when a required key is missing', () => {
    const p = new NodeModelProvider({ env: {} as NodeJS.ProcessEnv })
    expect(() => p.resolve({ provider: 'anthropic', model: 'claude-x' })).toThrow(/ANTHROPIC_API_KEY/)
  })
})

describe('runBenchmark', () => {
  it('runs requirement-review + code-review with a fake model and records exact model/prompt', async () => {
    const reviewJson = JSON.stringify({
      items: [{ category: 'gap', severity: 'high', title: 'Link expiry', detail: 'How long valid?' }],
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
    expect(rr.cell.prompt).toBe('requirement-review@v1')
    expect(rr.output).toContain('Link expiry')
    expect(rr.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
    const cr = results.find((r) => r.cell.task === 'code-review')!
    expect(cr.cell.prompt).toBe('review@v1')
    expect(cr.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
    expect(cr.output).toContain(reviewJson)
    // Cost is metered from the usage via core pricing.
    expect(cr.costEur).toBeGreaterThan(0)
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
