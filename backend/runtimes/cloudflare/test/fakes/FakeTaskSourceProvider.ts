// The deterministic task-source fake now lives in `@cat-factory/conformance` so the
// cross-runtime suite + both runtimes' tests share one copy. Re-exported here to keep
// the existing `../fakes/FakeTaskSourceProvider` import path stable.
export { FakeTaskSourceProvider } from '@cat-factory/conformance'
