import type { Notification } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultSlackSettings, renderNotificationMessage, resolveRoute } from './slack.logic.js'

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_1',
    type: 'merge_review',
    status: 'open',
    blockId: 'blk_1',
    executionId: 'exe_1',
    title: "Review PR for 'auth'",
    body: 'The merger scored this PR outside the auto-merge thresholds.',
    payload: null,
    createdAt: 0,
    resolvedAt: null,
    ...overrides,
  }
}

describe('defaultSlackSettings', () => {
  it('disables every routable type and mentions', () => {
    const settings = defaultSlackSettings(123)
    expect(settings.mentionsEnabled).toBe(false)
    expect(settings.updatedAt).toBe(123)
    for (const type of ['merge_review', 'pipeline_complete', 'ci_failed'] as const) {
      expect(settings.routes[type]).toEqual({ enabled: false, channel: '' })
    }
  })
})

describe('resolveRoute', () => {
  it('returns null when the type is missing, disabled, or unrouted', () => {
    expect(resolveRoute(defaultSlackSettings(0), 'merge_review')).toBeNull()
    expect(
      resolveRoute(
        {
          routes: { ci_failed: { enabled: false, channel: '#x' } },
          mentionsEnabled: false,
          updatedAt: 0,
        },
        'ci_failed',
      ),
    ).toBeNull()
    expect(
      resolveRoute(
        {
          routes: { ci_failed: { enabled: true, channel: '  ' } },
          mentionsEnabled: false,
          updatedAt: 0,
        },
        'ci_failed',
      ),
    ).toBeNull()
  })

  it('returns the channel when enabled and routed', () => {
    expect(
      resolveRoute(
        {
          routes: { merge_review: { enabled: true, channel: '#releases' } },
          mentionsEnabled: false,
          updatedAt: 0,
        },
        'merge_review',
      ),
    ).toBe('#releases')
  })
})

describe('renderNotificationMessage', () => {
  it('prefixes mentions, carries the PR link + assessment in context', () => {
    const msg = renderNotificationMessage(
      notification({
        payload: {
          assessment: { complexity: 0.4, risk: 0.2, impact: 0.9 },
          prUrl: 'https://github.com/a/b/pull/3',
          pipelineName: 'Full build',
        },
      }),
      '#releases',
      ['U1', 'U2'],
    )
    expect(msg.channel).toBe('#releases')
    expect(msg.text).toContain("Review PR for 'auth'")
    const json = JSON.stringify(msg.blocks)
    expect(json).toContain('<@U1> <@U2>')
    expect(json).toContain('Full build')
    expect(json).toContain('Complexity 40%')
    expect(json).toContain('Impact 90%')
    expect(json).toContain('https://github.com/a/b/pull/3')
  })

  it('omits the mention prefix when there are no mentions', () => {
    const msg = renderNotificationMessage(notification(), '#general', [])
    expect(JSON.stringify(msg.blocks)).not.toContain('<@')
  })
})
