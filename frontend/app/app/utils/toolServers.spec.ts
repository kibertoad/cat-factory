import { describe, expect, it } from 'vitest'
import type { DispatchedToolServer, ToolServerUnavailableReason } from '~/types/toolServers'
import { TOOL_SERVER_UNAVAILABLE_KEYS, toolServerRows } from './toolServers'

describe('toolServerRows', () => {
  it('puts what the agent HAD first, and keeps declaration order inside each half', () => {
    const servers: DispatchedToolServer[] = [
      { id: 'jira', label: 'Jira', status: 'unavailable', reason: 'missing_secret' },
      { id: 'slack', label: 'Slack', status: 'wired' },
      { id: 'figma', label: 'Figma', status: 'unavailable', reason: 'oauth_not_connected' },
      { id: 'github', label: 'GitHub', status: 'wired' },
    ]
    expect(toolServerRows(servers).map((row) => row.id)).toEqual([
      'slack',
      'github',
      'jira',
      'figma',
    ])
  })

  it('resolves every reason the wire vocabulary can carry to copy', () => {
    // Derived from the key map rather than a hand-listed set: the map is an exhaustive `Record`
    // over the contracts union, so a member added there fails the BUILD, and this then proves the
    // renderer actually reaches the copy rather than falling into the unknown branch.
    const reasons = Object.keys(TOOL_SERVER_UNAVAILABLE_KEYS) as ToolServerUnavailableReason[]
    for (const reason of reasons) {
      const [row] = toolServerRows([{ id: 's', label: 'S', status: 'unavailable', reason }])
      expect(row?.status).toBe('unavailable')
      expect(row && 'keys' in row ? row.keys : null).toEqual(TOOL_SERVER_UNAVAILABLE_KEYS[reason])
    }
  })

  it('renders a reason this build no longer knows as itself, rather than as a blank chip', () => {
    // The reason is PERSISTED on a run, so a step recorded before a member was retired still
    // arrives carrying it. Without the narrowing, the exhaustive `Record` returns undefined and
    // the row renders empty on the one surface someone opened to read why their tool was missing.
    const [row] = toolServerRows([
      {
        id: 'legacy',
        label: 'Legacy',
        status: 'unavailable',
        reason: 'retired_reason',
      } as unknown as DispatchedToolServer,
    ])
    expect(row).toEqual({
      id: 'legacy',
      label: 'Legacy',
      status: 'unavailable',
      keys: null,
      rawReason: 'retired_reason',
    })
  })

  it('reports a dropped server whose reason went missing entirely, not an empty label', () => {
    // An `unavailable` entry with no reason at all is not a shape the backend writes, but it IS
    // what a truncated or hand-edited persisted blob produces, and the row still has to say the
    // server was dropped rather than silently claiming it was wired.
    const [row] = toolServerRows([
      { id: 'x', label: 'X', status: 'unavailable' } as DispatchedToolServer,
    ])
    expect(row?.status).toBe('unavailable')
    expect(row && 'rawReason' in row ? row.rawReason : undefined).toBe('')
  })
})
