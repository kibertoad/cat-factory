// Public surface of the benchmark harness — usable as a library as well as a CLI.
export * from './types'
export { NodeModelProvider, type NodeModelProviderOptions } from './model-provider'
export { resolvePiEndpoint, cloudflareAiBaseUrl } from './endpoints'
export { rubricFor, weightedTotal } from './rubrics'
export { resolvePromptVariant, defaultVariant, type ResolvedPrompt } from './prompt-registry'
export {
  type BenchmarkConfig,
  benchmarkConfigSchema,
  defineConfig,
  loadConfig,
  TASK_PROMPT_ID,
} from './config'
export { runBenchmark, type RunOptions } from './run'
export { writeRunArtifacts, type RunManifest } from './artifacts'
export { buildReport, type ReportRow } from './report'
export {
  REQUIREMENT_REVIEW_FIXTURES,
  CODE_REVIEW_FIXTURES,
  IMPLEMENTATION_FIXTURES,
  type RequirementReviewFixture,
  type CodeReviewFixture,
  type ImplementationFixture,
} from './fixtures'
