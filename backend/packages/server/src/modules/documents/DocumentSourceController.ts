import {
  connectDocumentSourceContract,
  disconnectDocumentSourceContract,
  documentSourceKindSchema,
  documentSourceOAuthUrlContract,
  importDocumentContract,
  linkDocumentContract,
  linkDocumentForKindContract,
  listDocumentConnectionsContract,
  listDocumentRoleLinksContract,
  listDocumentSourcesContract,
  listDocumentsContract,
  planDocumentContract,
  refreshDocumentContract,
  resolveDocumentRefContract,
  searchDocumentsContract,
  spawnDocumentContract,
  unlinkDocumentForKindContract,
  type DocumentSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { UnauthorizedError, ValidationError } from '@cat-factory/kernel'
import type { DocumentsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import {
  blockEditAuthority,
  mountWorkspacePermission,
  requirePermission,
} from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { StateSigner } from '../../github/state.js'

/** Resolve the documents module, or refuse with a 503 naming what isn't wired. */
function requireDocuments<E extends AppEnv>(c: Context<E>): DocumentsModule {
  return requireCapability(
    c.get('container').documents,
    'Document-source integration is not configured',
  )
}

/**
 * How long a document-source OAuth `state` stays valid: long enough to sign in to a vendor and
 * approve a consent screen, short enough that an abandoned one cannot be replayed days later.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam<E extends AppEnv>(c: Context<E>): DocumentSourceKind {
  const source = param(c, 'source')
  if (!v.is(documentSourceKindSchema, source)) {
    throw new ValidationError(`Unknown document source '${source}'`)
  }
  return source
}

/**
 * Workspace-scoped, source-parameterized document endpoints: source discovery,
 * connection management, page import, document listing, structure
 * planning/spawning, and linking a page to a block as agent context. Mounted
 * under `/workspaces/:workspaceId`.
 *
 * **This controller MIXES tiers, and which half a route lands in is the whole point.**
 * Storing a credential is integration management; reaching for a page and putting it on a task is
 * board AUTHORING, done by whoever authors the task. Holding the whole controller at
 * `integrations.manage` made every write admin-only, so the persona the feature exists for (someone
 * who links the spec or the design their task is about, and is not an operator) could not attach
 * anything at all: the Add-task picker imports-then-links, so it failed on its first write. Import,
 * search, plan, spawn and link therefore sit at the MEMBER tier the auth gate's write floor already
 * enforces, exactly as `boardController`'s writes do, and only the two credential routes plus the
 * workspace-wide role tags keep the admin gate below.
 */
export function documentSourceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // The admin-tier half, named path by path rather than as a whole-controller mount:
  //
  // - connect/disconnect write and clear the per-workspace source CREDENTIAL, which is integration
  //   management by definition. Gating at the mount rather than per-handler keeps the refusal ahead
  //   of body validation, so a member is refused whether or not their payload is well-formed and
  //   never learns which sources this deployment configured; Gating at the mount rather than per-handler keeps the refusal ahead
  //   of body validation, so a member is refused whether or not their payload is well-formed and
  //   never learns which sources this deployment configured;
  // - the per-DocKind template / exemplar tags are workspace-wide authoring CONFIG, not one task's
  //   context. One tag decides what EVERY doc run in the board writes from, the same blast radius
  //   that keeps the fragment library and the agent-prompt overrides at the admin tier. The
  //   writes-only gate leaves the GET open, so the management panel still renders for anyone who
  //   can read the board.
  //
  // Everything else this controller serves is the member half, and mounts nothing.
  mountWorkspacePermission(app, 'integrations.manage', [
    '/document-sources/:source/connect',
    '/document-sources/:source/connection',
    '/document-role-links',
  ])

  // ---- source discovery ---------------------------------------------------

  // The configured sources + their connect/import metadata (drives the UI). A
  // 503 here is how the frontend learns the integration is off.
  buildHonoRoute(app, listDocumentSourcesContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(
      {
        sources: documents.connectionService.listSources(),
        // What a source DECLARES and what this deployment can RUN are two facts, so they travel
        // as two fields: a source with an OAuth half and no registered app still connects by
        // typed credential, and folding the two would render a button that can only 503.
        oauthSources: await documents.oauthService.availableSources(param(c, 'workspaceId')),
      },
      200,
    )
  })

  // ---- connections --------------------------------------------------------

  buildHonoRoute(app, listDocumentConnectionsContract, async (c) => {
    const documents = requireDocuments(c)
    const connections = await documents.connectionService.listConnections(param(c, 'workspaceId'))
    return c.json({ connections }, 200)
  })

  buildHonoRoute(app, connectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    const connection = await documents.connectionService.connect(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').credentials,
    )
    return c.json(connection, 201)
  })

  // Begin an `authorization_code` connect. The `state` binds the round trip to this workspace,
  // this user and a short expiry, and NAMES the source, because one registered redirect URL
  // serves every OAuth-capable source and the callback has nothing else to resolve a provider
  // from. Nothing is written here: an abandoned consent screen leaves no row behind.
  buildHonoRoute(app, documentSourceOAuthUrlContract, async (c) => {
    // The one route here gated IMPERATIVELY, because it is the one gated READ. The mount above
    // lets GET/HEAD through by design (on an admin controller the permission guards mutation and
    // the configuration itself is viewer-readable), and this read is the exception: what it hands
    // back is the first half of a credential write, completed through the PUBLIC callback where no
    // tier can be checked at all. Ahead of `requireDocuments`, so a refusal never doubles as a
    // report of which sources this deployment wired.
    requirePermission(c, 'integrations.manage')
    const documents = requireDocuments(c)
    const workspaceId = param(c, 'workspaceId')
    const source = sourceParam(c)
    const signer = new StateSigner(c.get('container').config.auth.sessionSecret)
    const state = await signer.sign({
      workspaceId,
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + OAUTH_STATE_TTL_MS,
      source,
    })
    return c.json(
      { url: await documents.oauthService.authorizeUrl({ workspaceId, source, state }) },
      200,
    )
  })

  buildHonoRoute(app, disconnectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    await documents.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c))
    return c.body(null, 204)
  })

  // ---- documents ----------------------------------------------------------

  buildHonoRoute(app, listDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(await documents.importService.listDocuments(param(c, 'workspaceId')), 200)
  })

  // The pure pre-flight the attach surfaces run before a task is saved: what a pasted URL/id
  // canonicalises to for this source, or a 422 naming which of the two corrections it needs. No
  // upstream call and no write, so it costs nothing to run as the user types.
  buildHonoRoute(app, resolveDocumentRefContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(documents.importService.resolveRef(sourceParam(c), c.req.valid('json').ref), 200)
  })

  // Member tier. It does spend an outbound call against the source under the workspace's stored
  // credential, which is the reason the tool-server probe is gated: the difference is that here the
  // call IS the feature, and the same credential is spent by every run a member may already start.
  buildHonoRoute(app, importDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const document = await documents.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
    )
    return c.json(document, 201)
  })

  // Re-confirm one stored document against its source now, pulling the new body if the page moved.
  // Member tier for the same reason import is: it spends the workspace's stored credential on a
  // page the member can already attach, and the write it may perform is a refresh of a projection
  // every run of theirs already reads.
  //
  // The `:source` here rides the BODY rather than the path, because this route is about a stored
  // row (whose key is `(source, externalId)`) rather than about a provider surface.
  buildHonoRoute(app, refreshDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId } = c.req.valid('json')
    return c.json(
      await documents.linkedRefresher.refreshNow(param(c, 'workspaceId'), source, externalId),
      200,
    )
  })

  // Search a source's catalogue by free text (title/content), returning lean hits
  // the picker can import + link on selection.
  buildHonoRoute(app, searchDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    const results = await documents.importService.search(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').query,
    )
    return c.json({ results }, 200)
  })

  // ---- planning / spawning ------------------------------------------------

  // Preview the board structure a page would expand into (no writes). Member tier because the
  // spawn it previews is a board write; in `llm` planner mode it also spends one model call, a
  // smaller spend than the run the same member may start on what it produces.
  buildHonoRoute(app, planDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const workspaceId = param(c, 'workspaceId')
    const { externalId, frameId } = c.req.valid('json')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      externalId,
    )
    const target = frameId
      ? await documents.linkService.resolvePlanTarget(workspaceId, frameId)
      : undefined
    return c.json(await documents.plannerService.plan(record, target), 200)
  })

  // Apply a page's structure to the board (new frames, or into an existing one).
  buildHonoRoute(app, spawnDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const workspaceId = param(c, 'workspaceId')
    const { externalId, frameId } = c.req.valid('json')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      externalId,
    )
    // The plan is re-derived for the SAME target the preview was rendered for, so the write
    // matches what the user approved: a board-wide plan flattened into a frame discards the frame
    // titles and types the preview showed, and a targeted one has nothing to discard.
    const target = frameId
      ? await documents.linkService.resolvePlanTarget(workspaceId, frameId)
      : undefined
    const plan = await documents.plannerService.plan(record, target)
    // The plan comes from an imported document, but the board write is the member's: they asked
    // for the spawn on their own board, so it is judged under their tier (ADR 0037).
    const result = await documents.linkService.spawn(
      workspaceId,
      plan,
      blockEditAuthority(c),
      frameId,
    )
    return c.json({ plan, result }, 201)
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported page to a block as extra agent context. Member tier: this is the write the
  // designer/author flow ends on, and it edits one block's context, nothing workspace-wide.
  buildHonoRoute(app, linkDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId, blockId } = c.req.valid('json')
    const document = await documents.linkService.linkToBlock(
      param(c, 'workspaceId'),
      blockId,
      source,
      externalId,
    )
    return c.json(document, 201)
  })

  // ---- workspace+DocKind template / exemplar links (WS1 items 2–4) --------

  // Every role-tagged document in the workspace (drives the template/exemplar management panel).
  buildHonoRoute(app, listDocumentRoleLinksContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(await documents.linkService.listRoleLinks(param(c, 'workspaceId')), 200)
  })

  // Tag an imported page as the workspace's template (singular per kind) or exemplar for a kind.
  buildHonoRoute(app, linkDocumentForKindContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId, role, docKind } = c.req.valid('json')
    const document = await documents.linkService.linkForKind(
      param(c, 'workspaceId'),
      source,
      externalId,
      role,
      docKind,
    )
    return c.json(document, 201)
  })

  // Clear a document's role tag (built-in template resumes for the kind / exemplar drops).
  buildHonoRoute(app, unlinkDocumentForKindContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId } = c.req.valid('json')
    await documents.linkService.unlinkForKind(param(c, 'workspaceId'), source, externalId)
    return c.body(null, 204)
  })

  return app
}

/**
 * Public document-source OAuth callback: the vendor redirects the operator's browser here with
 * `?code&state`, so it cannot be workspace-scoped or session-gated and the `state` is what carries
 * the trust. Mounted at `/documents`.
 *
 * ONE receiver for every OAuth-capable source, because a deployment registers ONE redirect URL per
 * vendor app and the path cannot vary per source. That is why the state names the source: without
 * it there is nothing to resolve a provider from, and a state minted by a DIFFERENT flow under the
 * same signing secret (the GitHub install, Slack, the Linear task connect, all of which mint no
 * `source`) would otherwise be presentable here.
 *
 * Mirrors the Linear task-source callback: the exchange happens server-side because the server
 * holds the client secret, and the resulting grant is stored as the workspace's connection.
 */
export function documentOAuthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/oauth/callback', async (c) => {
    const container = c.get('container')
    const documents = requireDocuments(c)

    const code = c.req.query('code')
    if (!code) throw new ValidationError('Missing code')

    const signer = new StateSigner(container.config.auth.sessionSecret)
    const state = await signer.verify(c.req.query('state') ?? null)
    if (!state) throw new UnauthorizedError('Invalid or expired state')
    if (!v.is(documentSourceKindSchema, state.source)) {
      // A state this deployment signed, for a flow that is not this one. Refused rather than
      // guessed at: there is no correct source to substitute, and picking one would complete a
      // grant against a provider the operator never consented to.
      throw new UnauthorizedError('This authorization was not started for a document source')
    }

    const credentials = await documents.oauthService.exchangeCode({
      workspaceId: state.workspaceId,
      source: state.source,
      code,
    })
    await documents.connectionService.connectWithOAuth(state.workspaceId, state.source, credentials)
    // Land back on the app (reuse the GitHub setup redirect target as the app URL).
    return c.redirect(container.config.github.setupRedirectUrl || '/')
  })

  return app
}
