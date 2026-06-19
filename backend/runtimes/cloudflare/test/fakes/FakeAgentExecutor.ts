// The deterministic agent is owned by @cat-factory/conformance so every runtime
// facade drives identical agent behaviour in its tests. Re-exported here to keep
// the existing `../fakes/FakeAgentExecutor` import sites unchanged.
export { FakeAgentExecutor, type FakeAgentOptions } from '@cat-factory/conformance'
