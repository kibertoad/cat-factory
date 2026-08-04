import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogRecord, LogSink } from '@cat-factory/kernel'
import {
  createPinoLogger,
  getLogLevel,
  getLogSink,
  parseLogLevel,
  serialize,
  setLogLevel,
  setLogSink,
} from '../src/observability/logger.js'

// The pino adapter is the ONE place the platform's message-first `Logger` port meets a logging
// library, and the level gate lives beside it rather than on the pino instance (a facade
// configures `LOG_LEVEL` after module load, and pino children snapshot their parent's level at
// creation). Both properties are pinned here.

afterEach(() => setLogLevel('info'))

/** A logger writing into an array, plus the parsed lines it has emitted so far. */
function capturing(): { logger: ReturnType<typeof createPinoLogger>; lines: () => unknown[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: unknown, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return {
    logger: createPinoLogger(stream),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as unknown),
  }
}

describe('parseLogLevel', () => {
  it('accepts the four supported levels, case- and space-insensitively', () => {
    expect(parseLogLevel('debug')).toBe('debug')
    expect(parseLogLevel(' WARN ')).toBe('warn')
    expect(parseLogLevel('error')).toBe('error')
  })

  it('falls back to info for anything else, including absent', () => {
    // An operator typo must not silence the deployment, so the fallback is the default tier
    // rather than the nearest match or a throw.
    expect(parseLogLevel(undefined)).toBe('info')
    expect(parseLogLevel('')).toBe('info')
    expect(parseLogLevel('verbose')).toBe('info')
  })
})

describe('the pino-backed logger', () => {
  it('emits the message and the fields as one structured line', () => {
    const { logger, lines } = capturing()
    logger.info('run advanced', { workspaceId: 'ws_1', step: 'coder' })
    expect(lines()).toEqual([
      expect.objectContaining({ msg: 'run advanced', workspaceId: 'ws_1', step: 'coder' }),
    ])
  })

  it("folds a child logger's bound fields into every line", () => {
    const { logger, lines } = capturing()
    logger.child({ workspaceId: 'ws_1' }).child({ executionId: 'exec_1' }).warn('poll failed')
    expect(lines()).toEqual([
      expect.objectContaining({ msg: 'poll failed', workspaceId: 'ws_1', executionId: 'exec_1' }),
    ])
  })

  it('drops lines below the active level', () => {
    const { logger, lines } = capturing()
    logger.debug('chatty')
    expect(lines()).toEqual([])
  })

  it('survives a field bag that cannot be serialised', () => {
    // The port promises a logger cannot throw. On the Worker the browser build hands the log
    // object to our own writer, so an unserialisable field there would raise out of the caller's
    // `logger.warn(…)` — hence the guarded stringify. The message must survive; the fields need
    // not.
    const circular: Record<string, unknown> = { workspaceId: 'ws_1' }
    circular.self = circular
    const line = serialize({ msg: 'poll failed', ...circular })
    expect(JSON.parse(line)).toMatchObject({ msg: 'poll failed' })
    expect(JSON.parse(line)).toHaveProperty('logSerializationError')
    expect(() => serialize({ msg: 'big', size: 1n })).not.toThrow()
  })

  it('applies a level raised AFTER a child was derived', () => {
    // The reason the gate is a module-level check rather than `pinoInstance.level`: a facade
    // resolves LOG_LEVEL from config, which can happen after loggers are already handed out.
    const { logger, lines } = capturing()
    const child = logger.child({ scope: 'test' })
    child.debug('invisible at info')
    setLogLevel('debug')
    child.debug('visible at debug')
    expect(lines().map((l) => (l as { msg: string }).msg)).toEqual(['visible at debug'])
    expect(getLogLevel()).toBe('debug')
  })
})

describe('the second destination (LogSink)', () => {
  /** A recording sink, plus the throwing one the fan-out has to survive. */
  function recordingSink(): LogSink & { records: LogRecord[] } {
    const records: LogRecord[] = []
    return { records, record: (r) => void records.push(r), flush: async () => {} }
  }

  afterEach(() => setLogSink(null))

  it('copies each emitted line, with the child-bound fields folded in', () => {
    const sink = recordingSink()
    setLogSink(sink)
    const { logger } = capturing()

    logger
      .child({ workspaceId: 'ws1' })
      .child({ executionId: 'exec1' })
      .warn('poll failed', { attempts: 2 })

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      level: 'warn',
      msg: 'poll failed',
      // Bound first, so a call site can still override a bound field.
      fields: { workspaceId: 'ws1', executionId: 'exec1', attempts: 2 },
    })
    expect(typeof sink.records[0]!.timeMs).toBe('number')
  })

  it('honours the level gate, so one dial governs both destinations', () => {
    const sink = recordingSink()
    setLogSink(sink)
    const { logger } = capturing()

    logger.debug('below the threshold')
    setLogLevel('debug')
    logger.debug('at the threshold')

    expect(sink.records.map((r) => r.msg)).toEqual(['at the threshold'])
  })

  it('survives a sink that throws, because a logger may not fail', () => {
    setLogSink({
      record: () => {
        throw new Error('sink is broken')
      },
      flush: async () => {},
    })
    const { logger, lines } = capturing()

    expect(() => logger.info('work continues')).not.toThrow()
    // …and the local writer still has the line, which is what an operator reads.
    expect(lines()).toHaveLength(1)
  })

  it('stops copying once detached', () => {
    const sink = recordingSink()
    setLogSink(sink)
    const { logger } = capturing()
    logger.info('exported')
    setLogSink(null)
    logger.info('local only')

    expect(getLogSink()).toBeNull()
    expect(sink.records.map((r) => r.msg)).toEqual(['exported'])
  })
})
