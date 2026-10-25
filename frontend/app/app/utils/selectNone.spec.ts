import { describe, it, expect } from 'vitest'
import {
  SELECT_NONE,
  fromSelectValue,
  selectNoneItem,
  selectNoneModel,
  toSelectValue,
} from './selectNone'

describe('selectNone', () => {
  it('gives the "no value" row a non-empty value, which Reka accepts', () => {
    // Reka's SelectItem and ComboboxItem throw on `value: ''`.
    expect(SELECT_NONE).not.toBe('')
    expect(selectNoneItem('Inherit')).toEqual({ label: 'Inherit', value: SELECT_NONE })
  })

  it('maps an empty or absent stored value to the sentinel', () => {
    expect(toSelectValue('')).toBe(SELECT_NONE)
    expect(toSelectValue(undefined)).toBe(SELECT_NONE)
    expect(toSelectValue(null)).toBe(SELECT_NONE)
  })

  it('passes a real stored value through', () => {
    expect(toSelectValue('24h')).toBe('24h')
  })

  it('maps the sentinel back to the empty string the component stores', () => {
    expect(fromSelectValue(SELECT_NONE)).toBe('')
    expect(fromSelectValue('pipeline-1')).toBe('pipeline-1')
  })

  it('maps both ways through one model', () => {
    let stored = ''
    const model = selectNoneModel(
      () => stored,
      (value) => {
        stored = value
      },
    )
    expect(model.value).toBe(SELECT_NONE)
    model.value = 'eu-west'
    expect(stored).toBe('eu-west')
    expect(model.value).toBe('eu-west')
    model.value = SELECT_NONE
    // The sentinel never reaches the stored value.
    expect(stored).toBe('')
  })

  it('round-trips every value', () => {
    for (const stored of ['', 'a', '7d']) {
      expect(fromSelectValue(toSelectValue(stored))).toBe(stored)
    }
  })
})
