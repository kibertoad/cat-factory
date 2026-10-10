import type { Notification } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  notificationDeepLink,
  renderNotificationEmail,
  resolveRecipientAddresses,
} from './emailNotification.logic.js'

const base: Notification = {
  id: 'ntf-1',
  type: 'ci_failed',
  status: 'open',
  severity: 'normal',
  blockId: 'blk-1',
  executionId: 'exec-1',
  title: 'CI is still red',
  body: 'The ci-fixer spent its attempt budget.',
  payload: null,
  createdAt: 0,
  resolvedAt: null,
}

describe('renderNotificationEmail', () => {
  it('leads with the type label so a mailbox reader can triage unopened', () => {
    const mail = renderNotificationEmail(base, { link: null })
    expect(mail.subject).toBe('CI failed: CI is still red')
    expect(mail.text).toContain('The ci-fixer spent its attempt budget.')
  })

  it('folds the payload context the card shows, and the link when there is one', () => {
    const mail = renderNotificationEmail(
      {
        ...base,
        type: 'merge_review',
        payload: {
          pipelineName: 'Full build',
          prUrl: 'https://example.test/pr/7',
          assessment: { complexity: 0.25, risk: 0.5, impact: 0.75 } as never,
        },
      },
      { link: 'https://app.example.test/?ws=ws-1' },
    )
    expect(mail.text).toContain('Pipeline: Full build')
    expect(mail.text).toContain('Complexity 25% · Risk 50% · Impact 75%')
    expect(mail.text).toContain('Pull request: https://example.test/pr/7')
    expect(mail.text).toContain('https://app.example.test/?ws=ws-1')
  })

  it('escapes model- and user-authored text in the HTML part', () => {
    const mail = renderNotificationEmail(
      { ...base, title: '<img src=x onerror=alert(1)>', body: 'a & b' },
      { link: null },
    )
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(mail.html).toContain('a &amp; b')
    // The plain-text part is inert, so it keeps the author's characters as written.
    expect(mail.text).toContain('<img src=x onerror=alert(1)>')
  })

  it('prefixes the workspace name when one is supplied', () => {
    expect(renderNotificationEmail(base, { link: null, workspaceName: 'Platform' }).subject).toBe(
      '[Platform] CI failed: CI is still red',
    )
  })
})

describe('notificationDeepLink', () => {
  it('carries the board, block and run so the link lands on the parked task', () => {
    expect(notificationDeepLink('https://app.example.test', 'ws-1', base)).toBe(
      'https://app.example.test/?ws=ws-1&block=blk-1&run=exec-1',
    )
  })

  it('omits what a block-less card does not have', () => {
    expect(
      notificationDeepLink('https://app.example.test/', 'ws-1', {
        ...base,
        blockId: null,
        executionId: null,
      }),
    ).toBe('https://app.example.test/?ws=ws-1')
  })

  it('is null when the deployment never declared its public URL', () => {
    expect(notificationDeepLink(undefined, 'ws-1', base)).toBeNull()
    expect(notificationDeepLink('  ', 'ws-1', base)).toBeNull()
  })
})

describe('resolveRecipientAddresses', () => {
  it('drops blanks and de-duplicates case-insensitively, keeping first-seen order', () => {
    expect(
      resolveRecipientAddresses([
        'Ada@example.test',
        null,
        '  ',
        'bo@example.test',
        'ada@example.test',
      ]),
    ).toEqual(['Ada@example.test', 'bo@example.test'])
  })
})
