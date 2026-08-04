// ---------------------------------------------------------------------------
// Emit each distinct config-parse warning ONCE per process, rather than once per read.
//
// The env parsers in this folder report a bad value the moment they meet it, which is right:
// silently falling back to a default is the gap they exist to close. What makes the emission
// site the wrong place to log unconditionally is WHERE they run. `loadConfig(env)` is not a
// boot-time call on every facade — the Worker re-derives the whole config on each invocation
// (`buildContainer`, the cron and queue entry points), so a single mistyped var is not one
// warning, it is one warning per request for as long as it stays mistyped. A list-valued knob
// like `PLATFORM_ALERTS_FAILURE_KIND_RATES` multiplies that again, once per malformed entry.
//
// A flood is not a louder signal, it is a quieter one: it buries the lines around it and it is
// the reason operators filter a level out. So the message is emitted the first time a process
// sees it and suppressed after, which on the Worker means once per isolate — often enough that
// a recycled isolate re-states a standing problem, rare enough that it never drowns anything.
//
// This is deliberately NOT the `AppCaches` seam, which the caching rule points at. Nothing here
// is cached state: there is no value to read back, nothing to invalidate, and nothing another
// node has to agree about. It is one process's record of what it has already said, and it must
// work at a point where the container (and therefore `container.caches`) does not exist yet,
// because parsing the config is what BUILDS the container.
// ---------------------------------------------------------------------------

import type { LogFields, Logger } from '@cat-factory/kernel'
import { logger } from '../observability/logger.js'

/**
 * A process's record of the config warnings it has already emitted.
 *
 * A class with an injected {@link Logger} rather than a bare module-level `Set`, so a test can
 * hold its own instance and assert the suppression against `createRecordingLogger()` instead of
 * needing a reset hook that only tests would call.
 */
export class ConfigWarningLog {
  readonly #seen = new Set<string>()
  readonly #logger: Logger

  constructor(log: Logger) {
    this.#logger = log
  }

  /**
   * Warn about a bad config value unless this exact message has already been emitted.
   *
   * The MESSAGE is the identity, which is what makes the dedup safe to apply blindly: every
   * message in this folder names its variable and quotes the offending value, so two genuinely
   * different problems cannot collide, and re-reading the same bad var is the only thing that
   * can. Returns whether the line was emitted, so a caller (or a test) can tell "said it" from
   * "already said it" without inspecting the sink.
   */
  warnOnce(message: string, fields: LogFields): boolean {
    if (this.#seen.has(message)) return false
    this.#seen.add(message)
    this.#logger.warn(message, fields)
    return true
  }
}

/** The process-wide instance the config parsers report through. */
export const configWarnings = new ConfigWarningLog(logger)
