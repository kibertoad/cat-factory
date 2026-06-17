import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as v from 'valibot'
import type { ModelCandidate, PromptVariant, TaskType } from './types'

// Benchmark configuration: the model × prompt-variant × task matrix to run.
// Authored as a JSON file or a TS module (default export, via `defineConfig`).
// Switching a model or prompt is a one-line edit here — no code change.

/** The prompt id each task varies. */
export const TASK_PROMPT_ID: Record<TaskType, string> = {
  'requirement-review': 'requirement-review',
  'code-review': 'review',
  implementation: 'build',
}

const modelRefSchema = v.object({
  provider: v.string(),
  model: v.string(),
})

const modelCandidateSchema = v.object({
  label: v.optional(v.string()),
  ref: modelRefSchema,
  endpoint: v.optional(v.object({ baseUrl: v.string(), keyEnv: v.string() })),
})

const promptVariantSchema = v.object({
  promptId: v.string(),
  version: v.optional(v.number()),
  label: v.optional(v.string()),
  system: v.optional(v.string()),
  temperature: v.optional(v.number()),
  maxOutputTokens: v.optional(v.number()),
})

const taskSchema = v.picklist(['requirement-review', 'code-review', 'implementation'])

export const benchmarkConfigSchema = v.object({
  name: v.optional(v.string()),
  /** Root dir for committed runs; defaults to docs/benchmarks. */
  outDir: v.optional(v.string()),
  /** Which tasks to run; defaults to all three. */
  tasks: v.optional(v.array(taskSchema)),
  /** Restrict to specific fixture ids (per task); defaults to all. */
  fixtures: v.optional(v.record(taskSchema, v.array(v.string()))),
  models: v.array(modelCandidateSchema),
  /** Prompt variants per task; defaults to the built-in versioned prompt. */
  prompts: v.optional(v.record(taskSchema, v.array(promptVariantSchema))),
})

export type BenchmarkConfig = v.InferOutput<typeof benchmarkConfigSchema> & {
  models: ModelCandidate[]
  prompts?: Partial<Record<TaskType, PromptVariant[]>>
}

/** Authoring helper for TS config files: `export default defineConfig({...})`. */
export function defineConfig(config: BenchmarkConfig): BenchmarkConfig {
  return config
}

/** Load + validate a config file (`.json` or a TS/JS module with a default export). */
export async function loadConfig(path: string): Promise<BenchmarkConfig> {
  let raw: unknown
  if (path.endsWith('.json')) {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } else {
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
    raw = mod.default
  }
  return v.parse(benchmarkConfigSchema, raw) as BenchmarkConfig
}
