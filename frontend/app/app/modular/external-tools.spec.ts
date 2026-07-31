import { describe, expect, it, vi } from 'vitest'
import {
  filterExternalTools,
  projectExternalTools,
  resolveExternalToolUrl,
  type ExternalToolContext,
  type ExternalToolContribution,
} from './external-tools'
import type { NavGates } from './nav-contributions'

const CONTEXT: ExternalToolContext = {
  userId: 'usr_1',
  userEmail: 'ada@example.com',
  workspaceId: 'ws_1',
  workspaceName: 'Zork',
  metadata: { gameId: 'zork' },
}

const MAP_EDITOR: ExternalToolContribution = {
  id: 'acme:map-editor',
  title: 'Map editor',
  icon: 'i-lucide-map',
  requiredMetadata: ['gameId'],
  url: (ctx) =>
    `https://maps.acme.dev/edit?game=${ctx.metadata.gameId}&ws=${ctx.workspaceId}&user=${ctx.userId ?? ''}`,
}

const GATES: NavGates = {
  canWriteBoard: true,
  canManageIntegrations: true,
  canManageSettings: true,
  githubAvailable: true,
  libraryAvailable: true,
  infrastructureAvailable: true,
  accountsEnabled: true,
  isAccountAdmin: true,
  advancedMode: true,
  boardHasService: true,
  boardHasTask: true,
  boardHasRun: true,
  boardHasOpenDecision: true,
  boardHasPendingApproval: true,
  boardHasFinishedRun: true,
}

describe('resolveExternalToolUrl', () => {
  it('folds the invocation context into the resolved URL', () => {
    // The whole point of a resolver over a static link: the tool opens on the right game,
    // for the right workspace, as the right user.
    expect(resolveExternalToolUrl(MAP_EDITOR, CONTEXT)).toEqual({
      ok: true,
      url: 'https://maps.acme.dev/edit?game=zork&ws=ws_1&user=usr_1',
    })
  })

  it('accepts a static URL with no resolver', () => {
    const tool = { ...MAP_EDITOR, requiredMetadata: undefined, url: 'https://acme.dev/console' }
    expect(resolveExternalToolUrl(tool, CONTEXT)).toMatchObject({ ok: true })
  })

  it('names the unfilled metadata fields instead of opening a half-scoped tool', () => {
    const empty = { ...CONTEXT, metadata: {} }

    // `missing-metadata` + the key list is what lets the UI say "fill in gameId in workspace
    // settings" — a bare "unavailable" would send the operator to the deployment's admins.
    expect(resolveExternalToolUrl(MAP_EDITOR, empty)).toEqual({
      ok: false,
      reason: 'missing-metadata',
      missing: ['gameId'],
    })
  })

  it('treats a required field stored as blank as missing', () => {
    // The store drops a cleared value, but a bag that arrived from anywhere else must not
    // resolve to `?game=`.
    const blank = { ...CONTEXT, metadata: { gameId: '' } }
    expect(resolveExternalToolUrl(MAP_EDITOR, blank)).toMatchObject({ reason: 'missing-metadata' })
  })

  it('reports a declining resolver separately from an unconfigured workspace', () => {
    const tool: ExternalToolContribution = { ...MAP_EDITOR, url: () => null }

    // Two different fixes: nobody to nag about settings here, this is the deployment's own
    // condition not being met.
    expect(resolveExternalToolUrl(tool, CONTEXT)).toEqual({
      ok: false,
      reason: 'unresolved',
      missing: [],
    })
  })

  it.each([
    // The security-relevant one: the resolved string is handed to `window.open`, so a
    // `javascript:` URL would execute in the SPA's own origin.
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    '/relative/path',
    'not a url',
  ])('refuses %s rather than handing it to the browser', (url) => {
    const tool: ExternalToolContribution = { ...MAP_EDITOR, url: () => url }
    expect(resolveExternalToolUrl(tool, CONTEXT)).toMatchObject({ reason: 'unsafe-url' })
  })
})

describe('projectExternalTools', () => {
  const handlers = () => ({ open: vi.fn(), onUnavailable: vi.fn() })

  it('projects a tool onto a nav contribution in the External tools section', () => {
    const [item] = projectExternalTools([MAP_EDITOR], CONTEXT, handlers())

    expect(item?.contribution).toMatchObject({
      id: 'acme:map-editor',
      // Deployment DATA rides `label`, so the shells render it verbatim instead of through `t()`.
      label: 'Map editor',
      icon: 'i-lucide-map',
      sidebar: { group: 'externalTools' },
      command: { group: 'externalTools' },
      testId: 'nav-external-tool-acme:map-editor',
    })
    expect(item?.contribution.surfaces).toEqual(['sidebar', 'command'])
  })

  it('orders by declared order, keeping registration order within a tie', () => {
    const tool = (id: string, order?: number): ExternalToolContribution => ({
      id,
      title: id,
      icon: 'i-lucide-link',
      url: 'https://acme.dev',
      ...(order === undefined ? {} : { order }),
    })
    const items = projectExternalTools(
      [tool('c', 20), tool('a'), tool('b'), tool('d', 10)],
      CONTEXT,
      handlers(),
    )

    expect(items.map((i) => i.tool.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(items.map((i) => i.contribution.sidebar?.order)).toEqual([0, 1, 2, 3])
  })

  it('opens the resolved URL on click', () => {
    const h = handlers()
    const [item] = projectExternalTools([MAP_EDITOR], CONTEXT, h)

    item?.contribution.run?.()

    expect(h.open).toHaveBeenCalledWith(
      'https://maps.acme.dev/edit?game=zork&ws=ws_1&user=usr_1',
      MAP_EDITOR,
    )
    expect(h.onUnavailable).not.toHaveBeenCalled()
  })

  it('keeps an unresolvable tool listed and reports why on click', () => {
    const h = handlers()
    const [item] = projectExternalTools([MAP_EDITOR], { ...CONTEXT, metadata: {} }, h)

    // Listed, not hidden: hiding it makes "nobody filled in gameId" look exactly like
    // "this deployment never registered a map editor", and the person who can fix it is
    // the one reading the sidebar.
    expect(item?.resolution).toMatchObject({ ok: false, reason: 'missing-metadata' })
    item?.contribution.run?.()
    expect(h.open).not.toHaveBeenCalled()
    expect(h.onUnavailable).toHaveBeenCalledWith(
      { ok: false, reason: 'missing-metadata', missing: ['gameId'] },
      MAP_EDITOR,
    )
  })

  it('re-resolves at click time, so a value filled in meanwhile is picked up', () => {
    const h = handlers()
    const metadata: Record<string, string> = {}
    // The composable passes a context built from reactive stores; a resolution captured at
    // projection time would keep reporting a fix that has already happened.
    const [item] = projectExternalTools([MAP_EDITOR], { ...CONTEXT, metadata }, h)
    expect(item?.resolution.ok).toBe(false)

    metadata.gameId = 'myst'
    item?.contribution.run?.()

    expect(h.open).toHaveBeenCalledWith(expect.stringContaining('game=myst'), MAP_EDITOR)
  })
})

describe('filterExternalTools', () => {
  const tools: ExternalToolContribution[] = [
    { id: 'a', title: 'A', icon: 'i', url: 'https://a.dev' },
    { id: 'b', title: 'B', icon: 'i', url: 'https://b.dev', gate: (g) => g.canManageIntegrations },
    { id: 'c', title: 'C', icon: 'i', url: 'https://c.dev', advanced: true },
  ]

  it('applies the RBAC gate and the interface tier independently', () => {
    expect(filterExternalTools(tools, GATES).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(
      filterExternalTools(tools, { ...GATES, canManageIntegrations: false }).map((t) => t.id),
    ).toEqual(['a', 'c'])
    expect(filterExternalTools(tools, { ...GATES, advancedMode: false }).map((t) => t.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('passes everything through with no gates service wired (dev-open parity)', () => {
    expect(filterExternalTools(tools, undefined).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
