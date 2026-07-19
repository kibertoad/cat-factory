import {
  createDocumentFragmentContract,
  createPromptFragmentContract,
  deletePromptFragmentContract,
  fragmentSourceStatusContract,
  linkFragmentSourceContract,
  listFragmentSourcesContract,
  listPromptFragmentsContract,
  refreshPromptFragmentContract,
  resolvedFragmentsContract,
  syncFragmentSourceContract,
  unlinkFragmentSourceContract,
  updatePromptFragmentContract,
} from '@cat-factory/contracts'
import { NotFoundError, ValidationError, type FragmentOwnerKind } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { FragmentLibraryModule } from '@cat-factory/orchestration'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { param } from '../../http/params.js'
import { loadWorkspaceAccess, requireWorkspacePermission } from '../../http/workspaceAccess.js'

type Scope = 'account' | 'workspace'

/** Resolve the fragment-library module or send a 503 when unconfigured. */
function requireLibrary<E extends AppEnv>(c: Context<E>): FragmentLibraryModule | null {
  return c.get('container').fragmentLibrary ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Prompt-fragment library is not configured' } },
    503,
  )

const sourcesUnavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Repo-sourced fragments require the GitHub integration to be configured',
      },
    },
    503,
  )

const documentsUnavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message:
          'Document-backed fragments require the document-source integration to be configured',
      },
    },
    503,
  )

/**
 * The prompt-fragment library API (ADR 0006 §8), mounted twice — once under
 * `/accounts/:accountId` and once under `/workspaces/:workspaceId` — so a tier's
 * fragments and repo sources are managed at the scope that owns them. Workspace
 * routes are authorized by the global per-workspace gate in app.ts; account
 * routes guard on account membership here. The merged/resolved read (what an
 * agent actually sees) is workspace-only.
 */
export function fragmentLibraryController(scope: Scope): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const ownerId = <E extends AppEnv>(c: Context<E>) =>
    scope === 'account' ? param(c, 'accountId') : param(c, 'workspaceId')
  const ownerKind: FragmentOwnerKind = scope

  // Account-scoped routes are an authenticated concept: require sign-in and
  // membership in the addressed account (404 hides existence, mirroring boards).
  if (scope === 'account') {
    app.use('/prompt-fragments', accountGuard)
    app.use('/prompt-fragments/*', accountGuard)
    app.use('/document-fragments', accountGuard)
    app.use('/fragment-sources', accountGuard)
    app.use('/fragment-sources/*', accountGuard)
  }

  // Workspace-scoped fragment WRITES are an admin-tier action (`settings.manage` — the
  // prompt-fragment library is workspace configuration); reads stay open to any resolved role.
  // The global gate already resolved the caller's access; account scope is authorized above.
  if (scope === 'workspace') {
    app.use('*', requireWorkspacePermission('settings.manage'))
  }

  // ---- fragments (this tier, raw — not merged) ----------------------------

  buildHonoRoute(app, listPromptFragmentsContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    return c.json(await lib.libraryService.listTier(ownerKind, ownerId(c)), 200)
  })

  buildHonoRoute(app, createPromptFragmentContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    const fragment = await lib.libraryService.create(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(fragment, 201)
  })

  buildHonoRoute(app, updatePromptFragmentContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    const fragment = await lib.libraryService.update(
      ownerKind,
      ownerId(c),
      c.req.valid('param').fragmentId,
      c.req.valid('json'),
    )
    return c.json(fragment, 200)
  })

  buildHonoRoute(app, deletePromptFragmentContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    await lib.libraryService.remove(ownerKind, ownerId(c), c.req.valid('param').fragmentId)
    return c.body(null, 204)
  })

  // ---- document-backed fragments (living source of truth) -----------------

  // Link an external document (Confluence/Notion page or GitHub file) as a
  // fragment whose body is re-resolved from the source at run time. The fetch
  // uses the addressed workspace's connection at the workspace scope, or the
  // body's `viaWorkspaceId` at the account scope (credentials are per-workspace).
  buildHonoRoute(app, createDocumentFragmentContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!c.get('container').documents) return documentsUnavailable(c)
    const input = c.req.valid('json')
    const viaWorkspaceId =
      scope === 'workspace' ? param(c, 'workspaceId') : (input.viaWorkspaceId ?? '')
    if (!viaWorkspaceId) {
      throw new ValidationError(
        'An account-tier document fragment needs `viaWorkspaceId` (the workspace whose connection to fetch through)',
      )
    }
    // SEC-RBAC-0: the account guard authorized only the PATH account; re-authorize the
    // body-supplied `viaWorkspaceId` before its credentials are used to fetch a document.
    if (scope === 'account') {
      await requireViaWorkspaceAccess(
        c.get('container'),
        c.get('user')?.id,
        ownerId(c),
        viaWorkspaceId,
      )
    }
    const fragment = await lib.libraryService.createFromDocument(
      ownerKind,
      ownerId(c),
      input,
      viaWorkspaceId,
    )
    return c.json(fragment, 201)
  })

  // Force an immediate live re-resolve of a document-backed fragment.
  buildHonoRoute(app, refreshPromptFragmentContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!c.get('container').documents) return documentsUnavailable(c)
    const viaWorkspaceId =
      scope === 'workspace' ? param(c, 'workspaceId') : (c.req.valid('query').viaWorkspaceId ?? '')
    if (!viaWorkspaceId) {
      throw new ValidationError(
        'An account-tier refresh needs a `viaWorkspaceId` query param (the workspace whose connection to fetch through)',
      )
    }
    // SEC-RBAC-0: re-authorize the query-supplied `viaWorkspaceId` (see createDocumentFragment).
    if (scope === 'account') {
      await requireViaWorkspaceAccess(
        c.get('container'),
        c.get('user')?.id,
        ownerId(c),
        viaWorkspaceId,
      )
    }
    const fragment = await lib.libraryService.refresh(
      ownerKind,
      ownerId(c),
      c.req.valid('param').fragmentId,
      viaWorkspaceId,
    )
    return c.json(fragment, 200)
  })

  // ---- repo sources -------------------------------------------------------

  buildHonoRoute(app, listFragmentSourcesContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(await lib.sourceService.list(ownerKind, ownerId(c)), 200)
  })

  buildHonoRoute(app, linkFragmentSourceContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    const source = await lib.sourceService.link(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(source, 201)
  })

  buildHonoRoute(app, unlinkFragmentSourceContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    await lib.sourceService.unlink(ownerKind, ownerId(c), c.req.valid('param').id)
    return c.body(null, 204)
  })

  buildHonoRoute(app, fragmentSourceStatusContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(
      await lib.sourceService.status(ownerKind, ownerId(c), c.req.valid('param').id),
      200,
    )
  })

  buildHonoRoute(app, syncFragmentSourceContract, async (c) => {
    const lib = requireLibrary(c)
    if (!lib) return unavailable(c)
    if (!lib.sourceService) return sourcesUnavailable(c)
    return c.json(await lib.sourceService.sync(ownerKind, ownerId(c), c.req.valid('param').id), 200)
  })

  // ---- resolved (workspace only) — the merged catalog an agent sees -------

  if (scope === 'workspace') {
    buildHonoRoute(app, resolvedFragmentsContract, async (c) => {
      const lib = requireLibrary(c)
      if (!lib) return unavailable(c)
      return c.json(await lib.libraryService.resolvedCatalog(param(c, 'workspaceId')), 200)
    })
  }

  return app
}

/**
 * Re-authorize a BODY/QUERY-supplied `viaWorkspaceId` before it is used to fetch through that
 * workspace's stored document-source credentials (SEC-RBAC-0). The account guard only authorized
 * the account in the URL PATH; a `viaWorkspaceId` taken from the request is an unauthorized
 * secondary id until proven to (a) belong to the SAME account and (b) be accessible to the caller.
 * Without this an account-A member could point `viaWorkspaceId` at workspace B (any account) and
 * drive B's stored Confluence/Notion/GitHub secret as a cross-tenant fetch oracle, exfiltrating any
 * document B's token can read into A's own library. Fails closed with the existence-hiding 404 the
 * workspace gate uses (never revealing whether the workspace exists / is in another account).
 *
 * `accountGuard` is the sign-in floor for EVERY account-tier route (it 401s a request with no
 * user), so a signed-in caller is always present here — including under dev-open, where the
 * account routes still require a real session (unlike the workspace gate, this tier never passes
 * through anonymously). A missing user is therefore a hard denial, never an allow-all: rejecting it
 * up front keeps the check fail-closed even if this helper is ever reused off an unguarded mount.
 */
async function requireViaWorkspaceAccess(
  container: ServerContainer,
  userId: string | undefined,
  accountId: string,
  viaWorkspaceId: string,
): Promise<void> {
  if (!userId) throw new NotFoundError('Workspace', viaWorkspaceId) // fail closed: no session ⇒ deny
  const account = await container.workspaceService.accountOf(viaWorkspaceId)
  // Not in the addressed account (or nonexistent) ⇒ 404, exactly as the gate hides a foreign board.
  if (account !== accountId) throw new NotFoundError('Workspace', viaWorkspaceId)
  const access = await loadWorkspaceAccess(container, viaWorkspaceId, userId)
  if (!access?.allowed) throw new NotFoundError('Workspace', viaWorkspaceId)
}

/** Guard an account-scoped request: require sign-in + membership (404 otherwise). */
async function accountGuard(c: Context<AppEnv>, next: () => Promise<void>) {
  const user = c.get('user')
  if (!user) {
    return c.json(
      { error: { code: 'unauthorized', message: 'Sign in to manage the library' } },
      401,
    )
  }
  // requireMember throws NotFoundError (→ 404) when the user isn't a member.
  await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
  await next()
}
