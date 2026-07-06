import { describe, expect, it } from 'vitest'
import { parseInlineHarnesses, parseNativeHarnesses } from './container.js'

// `LOCAL_NATIVE_AGENTS` opts a developer into running agents UNSANDBOXED on their own
// `claude`/`codex` CLI (no spend metering / model-locking), so an unintelligible value must
// fail SAFE (off) rather than silently enabling it. These pin that parsing contract.

describe('parseNativeHarnesses', () => {
  it('is OFF when unset or blank', () => {
    expect(parseNativeHarnesses(undefined)).toEqual([])
    expect(parseNativeHarnesses('')).toEqual([])
    expect(parseNativeHarnesses('   ')).toEqual([])
  })

  it('treats explicit disable values as OFF (never accidentally enabling native mode)', () => {
    for (const off of ['false', '0', 'off', 'no', 'none', 'disabled', 'FALSE', ' Off ']) {
      expect(parseNativeHarnesses(off)).toEqual([])
    }
  })

  it('enables the named harnesses (claude alias → claude-code)', () => {
    expect(parseNativeHarnesses('claude-code')).toEqual(['claude-code'])
    expect(parseNativeHarnesses('claude')).toEqual(['claude-code'])
    expect(parseNativeHarnesses('codex')).toEqual(['codex'])
    expect(parseNativeHarnesses('claude-code,codex').sort()).toEqual(['claude-code', 'codex'])
  })

  it('enables BOTH for an affirmative keyword that names no harness', () => {
    for (const on of ['true', '1', 'on', 'yes', 'all', 'both']) {
      expect(parseNativeHarnesses(on).sort()).toEqual(['claude-code', 'codex'])
    }
  })

  it('stays OFF for a non-affirmative unrecognised value (a typo fails safe)', () => {
    expect(parseNativeHarnesses('clyde')).toEqual([])
    expect(parseNativeHarnesses('enabled-maybe')).toEqual([])
  })

  it('warns about unrecognised tokens instead of dropping them silently', () => {
    // Fail-safe stays, but a typo'd `claudecode` must not disable native mode with ZERO
    // signal — the developer would only notice when runs start leasing credentials again.
    const warnings: string[] = []
    expect(parseNativeHarnesses('claudecode', (m) => warnings.push(m))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unrecognized value\(s\) 'claudecode'/)
    expect(warnings[0]).toMatch(/native mode stays OFF/)
  })

  it('warns about a stray token even when another token did enable a harness', () => {
    const warnings: string[] = []
    expect(parseNativeHarnesses('claude, codx', (m) => warnings.push(m))).toEqual(['claude-code'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/'codx'/)
    expect(warnings[0]).not.toMatch(/stays OFF/)
  })

  it('does not warn for recognised values or explicit off values', () => {
    const warnings: string[] = []
    parseNativeHarnesses('claude-code,codex', (m) => warnings.push(m))
    parseNativeHarnesses('off', (m) => warnings.push(m))
    parseNativeHarnesses(undefined, (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})

// `LOCAL_NATIVE_INLINE` governs the (benign, text-only) inline reviewer/brainstorm/estimator CLI
// path, so unlike `LOCAL_NATIVE_AGENTS` it defaults ON — a subscription-only preset can run its
// inline steps on the local `claude`/`codex` CLI in local/mothership mode with no extra setup.
describe('parseInlineHarnesses', () => {
  it('defaults ON (BOTH harnesses) when unset or blank', () => {
    expect(parseInlineHarnesses(undefined).sort()).toEqual(['claude-code', 'codex'])
    expect(parseInlineHarnesses('').sort()).toEqual(['claude-code', 'codex'])
    expect(parseInlineHarnesses('   ').sort()).toEqual(['claude-code', 'codex'])
  })

  it('treats explicit disable values as OFF', () => {
    for (const off of ['false', '0', 'off', 'no', 'none', 'disabled', 'FALSE', ' Off ']) {
      expect(parseInlineHarnesses(off)).toEqual([])
    }
  })

  it('restricts to the named harnesses (claude alias → claude-code)', () => {
    expect(parseInlineHarnesses('claude-code')).toEqual(['claude-code'])
    expect(parseInlineHarnesses('claude')).toEqual(['claude-code'])
    expect(parseInlineHarnesses('codex')).toEqual(['codex'])
    expect(parseInlineHarnesses('claude-code,codex').sort()).toEqual(['claude-code', 'codex'])
  })

  it('enables BOTH for an affirmative keyword that names no harness', () => {
    for (const on of ['true', '1', 'on', 'yes', 'all', 'both']) {
      expect(parseInlineHarnesses(on).sort()).toEqual(['claude-code', 'codex'])
    }
  })

  it('stays OFF for a non-affirmative unrecognised value, warning with the inline note', () => {
    // A typo does NOT silently fall back to the default-on set — it fails safe (off) AND warns,
    // so the developer isn't left thinking inline is on when their value was ignored.
    const warnings: string[] = []
    expect(parseInlineHarnesses('claudecode', (m) => warnings.push(m))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/LOCAL_NATIVE_INLINE/)
    expect(warnings[0]).toMatch(/'claudecode'/)
    expect(warnings[0]).toMatch(/inline subscription execution stays OFF/)
  })

  it('does not warn for recognised, affirmative, off, or unset values', () => {
    const warnings: string[] = []
    parseInlineHarnesses('claude-code,codex', (m) => warnings.push(m))
    parseInlineHarnesses('off', (m) => warnings.push(m))
    parseInlineHarnesses(undefined, (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})
