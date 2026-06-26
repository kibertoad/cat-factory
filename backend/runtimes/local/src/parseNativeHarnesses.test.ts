import { describe, expect, it } from 'vitest'
import { parseNativeHarnesses } from './container.js'

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
})
