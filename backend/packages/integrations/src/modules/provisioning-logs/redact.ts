// Secret scrubbing for the provisioning event log. The whole point of the log is to
// capture the VERBATIM provider/runtime error so an operator can debug a failed
// spin-up — but those error strings (and the structured `detail`) routinely carry
// credentials. Since these rows are persisted for the retention window and served to
// every workspace member via `GET /provisioning-logs`, we redact at the single recorder
// choke point so EVERY emitting site is covered uniformly. The scrubber itself is the
// shared, dependency-free `redactSecrets` in kernel (reused by the LLM-telemetry path).
export { redactSecrets } from '@cat-factory/kernel'
