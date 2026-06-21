import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as v from 'valibot'
import type { ModelCandidate } from './types'

// Smoketest configuration: which models to drive across which coding fixtures.
// Far smaller than the benchmark config (no prompt matrix, no rubrics) — a
// smoketest just answers "can this model actually do the work through our Pi
// setup, and where does it get stuck?". Authored as a JSON file or a TS module
// (default export, via `defineConfig`).

const modelRefSchema = v.object({
  provider: v.string(),
  model: v.string(),
})

const modelCandidateSchema = v.object({
  label: v.optional(v.string()),
  ref: modelRefSchema,
  endpoint: v.optional(v.object({ baseUrl: v.string(), keyEnv: v.string() })),
})

export const smoketestConfigSchema = v.object({
  name: v.optional(v.string()),
  /** Root dir for committed runs; defaults to docs/smoketests. */
  outDir: v.optional(v.string()),
  /** Models to smoketest. */
  models: v.array(modelCandidateSchema),
  /** Restrict to specific fixture ids; defaults to all built-in fixtures. */
  fixtures: v.optional(v.array(v.string())),
  /**
   * Relax the live no-progress guard so loops run to completion and are captured
   * whole, instead of Pi being killed at the guard threshold. Default false.
   */
  relaxGuard: v.optional(v.boolean()),
})

export type SmoketestConfig = v.InferOutput<typeof smoketestConfigSchema> & {
  models: ModelCandidate[]
}

/** Authoring helper for TS config files: `export default defineConfig({...})`. */
export function defineConfig(config: SmoketestConfig): SmoketestConfig {
  return config
}

/** Load + validate a config file (`.json` or a TS/JS module with a default export). */
export async function loadConfig(path: string): Promise<SmoketestConfig> {
  let raw: unknown
  if (path.endsWith('.json')) {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } else {
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
    raw = mod.default
  }
  return v.parse(smoketestConfigSchema, raw) as SmoketestConfig
}
