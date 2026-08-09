import { describe, expect, it } from 'vitest'
import {
  consumeKubernetesScrollAnchor,
  type ScrollableSection,
} from '~/components/settings/InfraHandlersConfigurator.logic'

/**
 * The `cat-factory k3s` hand-off promises the operator lands on the ONE form the CLI just filled
 * in. `k3sDeepLink.spec.ts` pins that the link arms the anchor; this pins the other half, that the
 * panel consumes it exactly once and only when there is something to scroll to.
 */
function recorder(): ScrollableSection & { calls: ScrollIntoViewOptions[] } {
  const calls: ScrollIntoViewOptions[] = []
  return { calls, scrollIntoView: (options) => calls.push(options) }
}

describe('consumeKubernetesScrollAnchor', () => {
  it('scrolls the section into view once the panel and the section are both there', () => {
    const section = recorder()
    const outcome = consumeKubernetesScrollAnchor({
      target: 'kubernetes',
      available: true,
      section,
    })

    expect(outcome).toBe('scrolled')
    expect(section.calls).toEqual([{ behavior: 'smooth', block: 'start' }])
  })

  it('does nothing when no anchor is pending, so a plain open never jumps', () => {
    const section = recorder()
    expect(consumeKubernetesScrollAnchor({ target: null, available: true, section })).toBe(
      'not-anchored',
    )
    expect(section.calls).toEqual([])
  })

  it('does nothing while the infra probe is still resolving', () => {
    // The whole configurator is behind `v-if="infra.available === true"`, and that probe resolves
    // AFTER the deep link fires: the section cannot be scrolled to before it exists.
    const section = recorder()
    expect(consumeKubernetesScrollAnchor({ target: 'kubernetes', available: null, section })).toBe(
      'not-anchored',
    )
    expect(section.calls).toEqual([])
  })

  it('leaves the anchor for the next attempt when the section has not rendered yet', () => {
    // `not-rendered` is what keeps the hand-off alive across the render the probe gates: only
    // `scrolled` tells the caller to clear the store's target, so a miss cannot swallow the link.
    const first = consumeKubernetesScrollAnchor({
      target: 'kubernetes',
      available: true,
      section: null,
    })
    expect(first).toBe('not-rendered')

    const section = recorder()
    expect(consumeKubernetesScrollAnchor({ target: 'kubernetes', available: true, section })).toBe(
      'scrolled',
    )
    expect(section.calls).toHaveLength(1)
  })
})
