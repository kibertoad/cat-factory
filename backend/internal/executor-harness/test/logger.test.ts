import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../src/logger.js'

// The logger writes pino-shaped JSON lines to stdout (debug/info) and stderr (warn/error).
// These tests capture those writes to assert the `child` field-binding + level routing.

function capture() {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
  return { out, err, restore: () => [outSpy, errSpy].forEach((s) => s.mockRestore()) }
}

afterEach(() => vi.restoreAllMocks())

describe('log.child', () => {
  it('merges bound fields into every line, with call-site fields winning on collision', () => {
    const cap = capture()
    const child = log.child({ jobId: 'exec-1', repo: 'o/r' })
    child.info('hello', { a: 1, repo: 'override' })
    cap.restore()

    expect(cap.out).toHaveLength(1)
    const line = JSON.parse(cap.out[0]!) as Record<string, unknown>
    expect(line.msg).toBe('hello')
    expect(line.jobId).toBe('exec-1')
    expect(line.a).toBe(1)
    // Call-site field overrides the bound one.
    expect(line.repo).toBe('override')
    expect(line.level).toBe('info')
  })

  it('nests: a child of a child accumulates bound fields', () => {
    const cap = capture()
    log.child({ jobId: 'exec-1' }).child({ kind: 'coder' }).warn('w')
    cap.restore()

    const line = JSON.parse(cap.err[0]!) as Record<string, unknown>
    expect(line.jobId).toBe('exec-1')
    expect(line.kind).toBe('coder')
  })

  it('routes warn/error to stderr and debug/info to stdout', () => {
    const cap = capture()
    log.info('i')
    log.debug('d')
    log.warn('w')
    log.error('e')
    cap.restore()

    expect(cap.out.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['i', 'd'])
    expect(cap.err.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['w', 'e'])
  })
})
