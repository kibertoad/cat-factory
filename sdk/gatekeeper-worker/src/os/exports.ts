// The named exports the OS object model reaches through, and the one place they are stated.
//
// A Worker's own entrypoints and Durable Object classes are reachable at runtime as
// `ctx.exports.<Name>`, resolved against the DEPLOYMENT's entry module rather than this package's.
// So the base cannot hold the names: it can only agree with the template about them, and this is
// the file that agreement lives in. Both `deploy/gatekeeper/src/index.ts` and the suite's
// `test/worker.ts` export exactly these, which is the same "the template's entry point and the
// suite's are the same lines" check the base/template split already leans on.
//
// `GATEKEEPER_VENDOR` is additionally the name the OS itself pins: a `GATEKEEPER_*` service binding
// targets a `WorkerEntrypoint` export called `GatekeeperVendor`, so that one is not ours to choose.
//
// A missing export is REFUSED by name rather than surfacing as `undefined is not a function`
// several calls later, and `/health` asks about all of them in one pass, so an operator wiring a
// deployment learns every missing line at once rather than one redeploy at a time.

import { GatekeeperError } from '../errors.js'

/** The export names the OS object model resolves, keyed by the role each plays. */
export const OS_EXPORTS = {
  /** The entrypoint a `GATEKEEPER_CAT_FACTORY` service binding targets. Pinned by the OS. */
  vendor: 'GatekeeperVendor',
  /** One connected account: what `createAccount()` hands back for the workspace to persist. */
  account: 'CatFactoryAccount',
  /** The per-resource Durable Object a bound workspace's session comes from. */
  resource: 'CatFactoryResource',
  /**
   * The bearer-of-identity another vendor's gatekeeper is handed when this account is added as an
   * observer there. It is a separate export because it must carry NO authority: handing over the
   * account itself would hand over `revoke()` and the resource classes with it.
   */
  verifier: 'CatFactoryVerifier',
  /**
   * The handle a workspace turns one bound hook on and off by.
   *
   * Its own export for the same reason the verifier is: what the workspace persists here must
   * carry the authority to disable ONE registration and nothing else. A session or an account
   * handed over instead would carry a capability, a key broker and every other hook with it.
   */
  hookController: 'CatFactoryHookController',
} as const satisfies Record<string, string>

/** A role in the object model, spelled as {@link OS_EXPORTS} keys it. */
export type OsExportRole = keyof typeof OS_EXPORTS

/** What a deployment loses by not exporting one role: the whole OS door, or one capability of it. */
export type OsExportRequirement = 'install' | 'hooks'

/**
 * What each role's absence actually costs, which is not the same answer for all of them.
 *
 * The four object-model roles are walked while a workspace installs this Gatekeeper, so a missing
 * one is a workspace that never finishes installing. The hook controller is reached only when a
 * session binds a hook, so a deployment without it installs, serves and answers exactly as before
 * and loses pushes. Reporting the two as one number would do the damage this file's own health
 * rule names in both directions at once: an operator told their Gatekeeper is undiscoverable when
 * it is serving, or told nothing at all about a capability that will refuse.
 */
export const OS_EXPORT_REQUIREMENT = {
  vendor: 'install',
  account: 'install',
  resource: 'install',
  verifier: 'install',
  hookController: 'hooks',
} as const satisfies Record<OsExportRole, OsExportRequirement>

/** What `ctx.exports` offers: a callable per export that imbues props and returns the stub. */
type LoopbackExports = Record<string, ((options: { props: unknown }) => unknown) | undefined>

/**
 * Read one factory out of a bag that may not be one.
 *
 * Total against an ABSENT bag as well as an incomplete one, because the two are the same fact here
 * (nothing is reachable) and only one of them would otherwise be reported: a caller with no
 * `ctx.exports` at all would get a `TypeError` from the read rather than the refusal that names
 * what is missing, which is the failure this whole module exists to turn into a sentence.
 */
function factoryFor(exports: unknown, name: string): LoopbackExports[string] {
  if (typeof exports !== 'object' || exports === null) return undefined
  const factory = (exports as LoopbackExports)[name]
  return typeof factory === 'function' ? factory : undefined
}

/**
 * Resolve one of this Worker's own exports, imbued with the props it should carry.
 *
 * The cast is the boundary between "what wrangler resolved" and "what this package needs", and the
 * refusal below is what makes it safe: an export the deployment did not write is named here rather
 * than reaching a caller as a missing method on a stub.
 */
export function loopbackExport<T>(exports: unknown, role: OsExportRole, props: unknown): T {
  const name = OS_EXPORTS[role]
  const factory = factoryFor(exports, name)
  if (factory === undefined) {
    throw new GatekeeperError(
      'missing_export',
      `This Worker's entry module does not export '${name}'. The Cloudflare OS object model ` +
        `reaches it as ctx.exports.${name}; add it to your entry module (deploy/gatekeeper/src/` +
        'index.ts is the template) and redeploy.',
    )
  }
  return factory({ props }) as T
}

/** Every export role the OS object model needs that this Worker does not carry. */
export function missingOsExports(exports: unknown): OsExportRole[] {
  const roles = Object.keys(OS_EXPORTS) as OsExportRole[]
  return roles.filter((role) => factoryFor(exports, OS_EXPORTS[role]) === undefined)
}
