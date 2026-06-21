// Public surface of the smoketest harness — usable as a library as well as a CLI.
export * from './types'
export { type SmoketestConfig, smoketestConfigSchema, defineConfig, loadConfig } from './config'
export { SMOKETEST_FIXTURES, type ImplementationFixture } from './fixtures'
export { analyzeCase, computeMetrics, type AnalyzeInput } from './analyze'
export { renderTranscript } from './transcript'
export { runCase, userPrompt, caseId, type RunCaseOptions, type RunCaseOutput } from './case'
export { runSmoketests, type RunOptions } from './run'
export { writeRunArtifacts, toResult, type RunManifest } from './artifacts'
