import { describe, it, expect } from 'vitest'
import {
  ESTIMATE_AXES,
  ESTIMATE_AXIS_FIELD,
  ESTIMATE_AXIS_HINT_KEYS,
  ESTIMATE_AXIS_LABEL_KEYS,
  estimateBasisLabelKey,
  parseAxisThreshold,
} from './estimateGating'

describe('parseAxisThreshold', () => {
  it('clears the axis on an empty or unparseable field rather than storing a zero floor', () => {
    // The two are opposites: an unset axis is not considered, where a 0 floor always passes.
    expect(parseAxisThreshold('')).toBeUndefined()
    expect(parseAxisThreshold('   ')).toBeUndefined()
    expect(parseAxisThreshold('abc')).toBeUndefined()
    expect(parseAxisThreshold('0')).toBe(0)
  })

  it('keeps a value inside the estimator scale', () => {
    expect(parseAxisThreshold('0.6')).toBe(0.6)
    expect(parseAxisThreshold(' 0.25 ')).toBe(0.25)
  })

  it('clamps out-of-range input instead of rejecting it', () => {
    // A fat-fingered extra digit lands on the ceiling rather than failing the save with a 422.
    expect(parseAxisThreshold('10')).toBe(1)
    expect(parseAxisThreshold('-3')).toBe(0)
  })
})

describe('estimate axis vocabulary', () => {
  it('covers every axis in both key maps and the field map', () => {
    for (const axis of ESTIMATE_AXES) {
      expect(ESTIMATE_AXIS_LABEL_KEYS[axis]).toBeTruthy()
      expect(ESTIMATE_AXIS_HINT_KEYS[axis]).toBeTruthy()
      expect(ESTIMATE_AXIS_FIELD[axis]).toBeTruthy()
    }
  })

  it('gives each axis its own hint, so no two axes explain the same thing', () => {
    const hints = ESTIMATE_AXES.map((axis) => ESTIMATE_AXIS_HINT_KEYS[axis])
    expect(new Set(hints).size).toBe(ESTIMATE_AXES.length)
  })
})

describe('estimate basis labels', () => {
  it('labels a stored basis this build knows', () => {
    expect(estimateBasisLabelKey('predicted')).toBe('inspector.estimate.basis.predicted')
    expect(estimateBasisLabelKey('observed')).toBe('inspector.estimate.basis.observed')
  })

  it('reads an ABSENT basis as the forecast it was', () => {
    // Every estimate written before the vocabulary existed came from the estimator, and those rows
    // are read back with a plain `JSON.parse`, so the field is genuinely missing rather than
    // defaulted on the way in.
    expect(estimateBasisLabelKey(undefined)).toBe('inspector.estimate.basis.predicted')
  })

  it('says so for a basis this bundle cannot name, instead of guessing', () => {
    // A browser holds a bundle older than the member it reads. Guessing onto a current member would
    // relabel a measurement as a forecast with nothing on screen to say so.
    expect(estimateBasisLabelKey('sampled')).toBe('inspector.estimate.basis.unknown')
    expect(estimateBasisLabelKey('')).toBe('inspector.estimate.basis.unknown')
  })
})
