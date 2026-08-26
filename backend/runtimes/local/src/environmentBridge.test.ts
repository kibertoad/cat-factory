import { describe, expect, it } from 'vitest'
import { environmentHostNeedingBridge } from './environmentBridge.js'

describe('environmentHostNeedingBridge', () => {
  it('names the host of a loopback environment URL', () => {
    expect(environmentHostNeedingBridge('http://cf-acc-pr8.127.0.0.1.nip.io/health')).toBe(
      'cf-acc-pr8.127.0.0.1.nip.io',
    )
    expect(environmentHostNeedingBridge('http://localhost:8080')).toBe('localhost')
  })

  it('needs nothing for a genuinely remote environment', () => {
    // The harmful direction: bridging this would break an environment the container could reach.
    expect(environmentHostNeedingBridge('https://pr8.staging.example.com')).toBeNull()
  })

  it('needs nothing when there is no URL, or it is not one', () => {
    for (const url of [null, undefined, '', 'not a url', 'http://']) {
      expect(environmentHostNeedingBridge(url), String(url)).toBeNull()
    }
  })
})
