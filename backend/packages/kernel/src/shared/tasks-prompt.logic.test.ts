import { describe, expect, it } from 'vitest'
import { renderTaskContext, type TaskContextView } from './tasks-prompt.logic.js'

// The tracker ticket as an agent reads it. Everything here lands verbatim in a prompt, so a
// dropped field is a fact the model never learns and an unlabelled one is a fact it may
// misattribute.

const view = (over: Partial<TaskContextView> = {}): TaskContextView => ({
  key: 'ENG-12',
  url: 'https://tracker/ENG-12',
  title: 'Login times out',
  status: 'In Progress',
  type: 'Bug',
  assignee: null,
  priority: null,
  labels: [],
  description: '',
  comments: [],
  ...over,
})

describe('renderTaskContext', () => {
  it('leads with the ticket key, title and link', () => {
    expect(renderTaskContext(view()).split('\n')[0]).toBe(
      '### [ENG-12] Login times out (https://tracker/ENG-12)',
    )
  })

  it('states the status and type even when the tracker reported neither', () => {
    // "Unknown" and "not reported" must not render as an absent line: an agent reading no status
    // at all would assume the ticket is fresh.
    expect(renderTaskContext(view({ status: '', type: '' })).split('\n')[1]).toBe(
      'Status: (unknown) · Type: (unknown)',
    )
  })

  it('adds each optional metadata field only when the ticket carries it', () => {
    const line = renderTaskContext(
      view({ assignee: 'alice', priority: 'High', labels: ['auth', 'regression'] }),
    ).split('\n')[1]
    expect(line).toBe(
      'Status: In Progress · Type: Bug · Assignee: alice · Priority: High · Labels: auth, regression',
    )
    const sparse = renderTaskContext(view()).split('\n')[1]
    expect(sparse).not.toContain('Assignee')
    expect(sparse).not.toContain('Priority')
    expect(sparse).not.toContain('Labels')
  })

  it('includes the description under a blank line, and omits an empty one entirely', () => {
    expect(renderTaskContext(view({ description: '  It hangs at 30s.  ' }))).toContain(
      '\n\nIt hangs at 30s.',
    )
    expect(renderTaskContext(view({ description: '   ' }))).not.toContain('\n\n')
  })

  it('keeps the MOST RECENT comments, capped, and says which they are', () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({
      author: `person-${i}`,
      body: `comment ${i}`,
      createdAt: '2026-07-0'.concat(String(i + 1), 'T10:00:00.000Z'),
    }))
    const rendered = renderTaskContext(view({ comments }))
    expect(rendered).toContain('Recent comments:')
    // The tail, not the head: the newest five are the ones that still describe the ticket.
    expect(rendered).not.toContain('comment 2')
    expect(rendered).toContain('comment 3')
    expect(rendered).toContain('comment 7')
    expect(rendered.match(/^- /gm)).toHaveLength(5)
  })

  it('renders each comment as author, date and an excerpt of the body', () => {
    const rendered = renderTaskContext(
      view({
        comments: [
          { author: 'bob', body: '**Still** broken', createdAt: '2026-07-01T10:00:00.000Z' },
        ],
      }),
    )
    expect(rendered).toContain('- bob (2026-07-01): Still broken')
  })

  it('names an unattributed comment rather than rendering an empty author', () => {
    const rendered = renderTaskContext(
      view({ comments: [{ author: '', body: 'anonymous note', createdAt: '' }] }),
    )
    expect(rendered).toContain('- unknown: anonymous note')
  })

  it('omits the comments section entirely when the ticket has none', () => {
    expect(renderTaskContext(view())).not.toContain('Recent comments:')
  })
})
