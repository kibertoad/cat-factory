---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/workspaces': minor
'@cat-factory/consensus': minor
'@cat-factory/gates': minor
'@cat-factory/caching': minor
'@cat-factory/observability-otel': minor
'@cat-factory/observability-langfuse': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Introduce a central, pino-backed structured logger behind a kernel `Logger` port, so the whole
domain engine can log — previously only `@cat-factory/server` and the runtime facades could, which
forced the domain packages to swallow failures silently.

- **New**: `Logger` / `noopLogger` / `createRecordingLogger` (`@cat-factory/kernel`,
  `ports/logging.ts`), and `runBestEffort` / `describeError` (`shared/best-effort.ts`) as the
  replacement for `.catch(() => {})`. `@cat-factory/server` exports `createPinoLogger`,
  `parseLogLevel`, `setLogLevel` and `getLogLevel` alongside the process-wide `logger`.
- **`LOG_LEVEL`** is now honoured (`process.env` on Node/local, a wrangler var on the Worker);
  it was previously read from a global nothing ever assigned.
- **Node/local** register `unhandledRejection`/`uncaughtException` guards and subscribe to
  pg-boss's `error` event (an unhandled one on an EventEmitter throws). The guards add the
  structured line only — both still exit non-zero, matching what Node already did (since Node 15
  an unhandled rejection is raised as an uncaught exception), so process lifetime is unchanged.

**Breaking (pre-1.0, no shims):**

- The logger's calling convention is now **message-first**: `logger.warn(msg, fields)`, not pino's
  `logger.warn(fields, msg)`. `Logger` is the kernel port type, no longer pino's own.
- Every ad-hoc logger interface is **removed**, not deprecated: `PrReportLogger`,
  `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
  `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
  `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`. Every `logger?:` dependency now takes the
  kernel `Logger`.
- `@cat-factory/node-server` no longer exports `pinoKeyFingerprintLogger` (the shapes match, so the
  bridge is gone). `@cat-factory/orchestration`'s `Core` gains a required `logger`.
- **`CoreDependencies.logger` is REQUIRED**, not optional. A facade or harness assembling the bag
  by hand must pass one (`noopLogger` if it does not care) or it will not typecheck — the guard
  that would have caught the Worker shipping with no logger wired at all.

Also fixes `MergeTrackRecordService.classify` losing the repo identity when `listChangedFiles`
throws, which permanently broke external-merge attribution for that record.
