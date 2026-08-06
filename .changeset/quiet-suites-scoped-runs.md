---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
---

Add `LogThreshold` (`LogLevel | 'silent'`) and widen the level gate to accept it, so a package's
vitest `setupFiles` can silence the process-wide logger for a suite. `LogLevel` stays the four emit
levels, keeping the OTLP severity maps exhaustive; `parseLogLevel` deliberately does not honour
`silent`, so no `LOG_LEVEL` value can mute a deployment.
