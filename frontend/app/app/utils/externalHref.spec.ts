import { describe, expect, it } from 'vitest'
import { externalHref } from './externalHref'

describe('externalHref', () => {
  it('links an ordinary http or https url', () => {
    expect(externalHref('https://github.com/acme/widgets/actions/runs/99')).toBe(
      'https://github.com/acme/widgets/actions/runs/99',
    )
    expect(externalHref('http://ci.internal/jobs/12')).toBe('http://ci.internal/jobs/12')
  })

  it('refuses a scheme that would EXECUTE in this origin', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>']) {
      expect(externalHref(url)).toBeNull()
    }
  })

  it('refuses what it cannot parse, and says nothing about an absent url', () => {
    expect(externalHref('/relative/path')).toBeNull()
    expect(externalHref('')).toBeNull()
    expect(externalHref(null)).toBeNull()
    expect(externalHref(undefined)).toBeNull()
  })
})
