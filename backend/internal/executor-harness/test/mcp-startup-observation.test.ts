import { describe, expect, it } from 'vitest'
import { observeClaudeMcpInit } from '../src/agent-capabilities.js'

// The CLI's own startup report about the tool servers it loaded — the OBSERVED half of a run's
// tool-server record. What these pin is the set of distinctions the field exists to preserve, each
// of which reads as a working server if it collapses:
//
//   absent report ≠ empty report ≠ a server that started and exposes nothing,
//   and an unrecognised status ≠ a server the CLI never named.

/** A claude-code `system`/`init` event, with only the fields this parser reads. */
function initEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: 's1', ...over }
}

describe('observeClaudeMcpInit', () => {
  it('ignores every event that is not the session announcement', () => {
    expect(observeClaudeMcpInit({ type: 'assistant', message: {} })).toBeUndefined()
    // Same `type`, different `subtype`: the CLI emits other system events during a run and only
    // the init one carries the resolved session.
    expect(
      observeClaudeMcpInit({ type: 'system', subtype: 'compact', mcp_servers: [{ name: 'a' }] }),
    ).toBeUndefined()
  })

  it('reports nothing when the CLI named no servers, rather than an empty list', () => {
    // The distinction the whole channel rests on: a run that wired no tool servers must leave the
    // backend's record ABSENT, because an empty list there would read as "the CLI loaded none of
    // the servers it was given".
    expect(observeClaudeMcpInit(initEvent())).toBeUndefined()
    expect(observeClaudeMcpInit(initEvent({ mcp_servers: [] }))).toBeUndefined()
  })

  it('maps each status synonym onto the closed vocabulary', () => {
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [
          { name: 'connected-one', status: 'connected' },
          { name: 'ready-one', status: 'ready' },
          { name: 'failed-one', status: 'failed' },
          { name: 'error-one', status: 'error' },
          { name: 'auth-one', status: 'needs-auth' },
        ],
      }),
    )
    expect(observed?.map((s) => [s.id, s.status])).toEqual([
      ['connected-one', 'ready'],
      ['ready-one', 'ready'],
      ['failed-one', 'failed'],
      ['error-one', 'failed'],
      ['auth-one', 'needs_auth'],
    ])
  })

  it('reports a server still handshaking as unknown, never as needing authorization', () => {
    // `pending` is the CLI saying the server had no resolved state when it announced the session,
    // which is what `unknown` means. Reading it as `needs_auth` paints a server that came up a
    // second later as one waiting for a credential, and sends an operator to re-issue a working
    // token: a fault attributed to the one party who did nothing wrong.
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [
          { name: 'slow-one', status: 'pending' },
          { name: 'handshaking-one', status: 'connecting' },
        ],
      }),
    )
    expect(observed?.map((s) => [s.id, s.status])).toEqual([
      ['slow-one', 'unknown'],
      ['handshaking-one', 'unknown'],
    ])
  })

  it('reports an unmappable status as unknown rather than dropping the server', () => {
    // A CLI that adds a status word must not make the server vanish from the report: dropping it
    // reads as a server the CLI never loaded, which is a different fault with a different fix.
    const observed = observeClaudeMcpInit(
      initEvent({ mcp_servers: [{ name: 'slack', status: 'reticulating' }, { name: 'jira' }] }),
    )
    expect(observed).toEqual([
      { id: 'slack', status: 'unknown' },
      { id: 'jira', status: 'unknown' },
    ])
  })

  it('counts each server’s tools out of the CLI’s flat tool list', () => {
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [
          { name: 'slack', status: 'connected' },
          { name: 'jira', status: 'connected' },
        ],
        tools: [
          'Bash',
          'Read',
          'mcp__slack__post_message',
          'mcp__slack__list_channels',
          'mcp__jira__search',
          // A tool name may itself contain `__`; it still belongs to the server whose id prefixes
          // it, which is `slack`.
          'mcp__slack__get__thread',
          // None of these names a declared server; all must be ignored rather than counted.
          'mcp__Not-An-Id__x',
          'mcp__malformed',
          'mcp__slack__',
        ],
      }),
    )
    expect(observed).toEqual([
      { id: 'slack', status: 'ready', toolCount: 3 },
      { id: 'jira', status: 'ready', toolCount: 1 },
    ])
  })

  it('attributes a tool to a server whose own id contains the separator', () => {
    // The id vocabulary permits `_`, so `code__search` is a legal server id and owns
    // `mcp__code__search__query`. Splitting on the first separator files that tool under a server
    // called `code` that nothing declared, and leaves the real one reporting `toolCount: 0`, the
    // one value that reads as "it started and exposes nothing" while every other signal says
    // healthy.
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [{ name: 'code__search', status: 'connected' }],
        tools: ['Bash', 'mcp__code__search__query', 'mcp__code__search__index'],
      }),
    )
    expect(observed).toEqual([{ id: 'code__search', status: 'ready', toolCount: 2 }])
  })

  it('leaves the count absent for servers a tool name cannot be attributed between', () => {
    // With both `code` and `code__search` declared, `mcp__code__search__query` is a name either
    // could own and the report does not say which. Counting it for one moves a real tool onto the
    // wrong server and takes the other's count to a 0 that reads as a fault, so both counts stay
    // absent while the unambiguous third server keeps its own.
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [
          { name: 'code', status: 'connected' },
          { name: 'code__search', status: 'connected' },
          { name: 'jira', status: 'connected' },
        ],
        tools: ['mcp__code__search__query', 'mcp__jira__search'],
      }),
    )
    expect(observed).toEqual([
      { id: 'code', status: 'ready' },
      { id: 'code__search', status: 'ready' },
      { id: 'jira', status: 'ready', toolCount: 1 },
    ])
  })

  it('reports a connected server that exposes no tools as 0, not as uncounted', () => {
    // The most diagnostic count there is: everything else about this server says healthy, and it
    // reaches the agent exactly like a server that was never wired.
    const observed = observeClaudeMcpInit(
      initEvent({ mcp_servers: [{ name: 'slack', status: 'connected' }], tools: ['Bash'] }),
    )
    expect(observed).toEqual([{ id: 'slack', status: 'ready', toolCount: 0 }])
  })

  it('leaves the count ABSENT when the CLI listed no tools at all', () => {
    // Absent means "this image counted nothing"; 0 means "it counted, and there were none". A
    // default of 0 here would accuse every server on a CLI build that omits the list.
    const observed = observeClaudeMcpInit(
      initEvent({ mcp_servers: [{ name: 'slack', status: 'connected' }] }),
    )
    expect(observed).toEqual([{ id: 'slack', status: 'ready' }])
    expect(observed?.[0]).not.toHaveProperty('toolCount')
  })

  it('drops entries with an unusable or duplicated id', () => {
    // The row is only useful if it JOINS the backend's declaration, and an id that cannot be one
    // names nothing an operator can act on.
    const observed = observeClaudeMcpInit(
      initEvent({
        mcp_servers: [
          { name: 'Slack', status: 'connected' },
          { name: '', status: 'connected' },
          { name: 42, status: 'connected' },
          null,
          { name: 'jira', status: 'connected' },
          { name: 'jira', status: 'failed' },
        ],
      }),
    )
    expect(observed).toEqual([{ id: 'jira', status: 'ready' }])
  })
})
