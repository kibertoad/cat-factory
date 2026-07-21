import type { KeyFingerprintLogger } from '@cat-factory/server'
import type { logger as pinoLogger } from '@cat-factory/server'

// ADR 0026 D6.1 — adapt the process pino logger to the runtime-neutral
// {@link KeyFingerprintLogger} the shared boot check expects (message-first, with a fields
// object), so the Node facade can run `checkKeyFingerprint` at boot.

type PinoLogger = typeof pinoLogger

/** Bridge a pino logger (`(obj, msg)`) to the message-first KeyFingerprintLogger. */
export function pinoKeyFingerprintLogger(log: PinoLogger): KeyFingerprintLogger {
  return {
    info: (message, fields) => log.info(fields ?? {}, message),
    warn: (message, fields) => log.warn(fields ?? {}, message),
    error: (message, fields) => log.error(fields ?? {}, message),
  }
}
