import {
  getTutorialProgressContract,
  recordTutorialEventContract,
  resetTutorialProgressContract,
  updateTutorialProgressContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { assertUser, requireCapability, requireUser } from '../../http/guards.js'

// The in-app tutorial's server surface. Two unrelated things behind one resource, deliberately:
//
//  - PROGRESS: per-user state (finished walkthroughs, spent contextual offers, the launch-prompt
//    answer), so the tutorial follows the person rather than the browser profile. Absent
//    persistence ⇒ 503, and the SPA carries on with its own local copy.
//  - EVENTS: the funnel counters, which store nothing at all.
//
// Root-mounted, like `/user-settings` and personal subscriptions, and NOT under
// `/workspaces/:ws/*` — that prefix carries the RBAC viewer write floor (any non-GET needs
// >= member), and a read-only viewer taking a walkthrough is precisely who this must serve.

/** Resolve the per-user progress store, or refuse with a 503 naming what isn't wired. */
function requireProgress<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').tutorialProgress,
    'Tutorial progress storage is not configured',
  )
}

const SIGN_IN = 'Sign in to keep your tutorial progress'

/** The signed-in caller, or a 401 wording the prompt for what this controller manages. */
function requireSignedIn<E extends AppEnv>(c: Context<E>) {
  return requireUser(c, SIGN_IN)
}

export function tutorialController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Sign-in is checked BEFORE the capability on every route here: the 503 names what this
  // deployment has not wired, and an anonymous caller has no business learning that. Same ordering
  // the RBAC permission gate uses for the same reason (`requireWorkspacePermission` runs ahead of a
  // controller's own 503), which is why these read auth-first rather than following the
  // capability-first shape of the older per-user controllers beside them.
  buildHonoRoute(app, getTutorialProgressContract, async (c) => {
    const user = requireSignedIn(c)
    return c.json(await requireProgress(c).service.get(user.id), 200)
  })

  buildHonoRoute(app, updateTutorialProgressContract, async (c) => {
    const user = requireSignedIn(c)
    return c.json(await requireProgress(c).service.merge(user.id, c.req.valid('json')), 200)
  })

  buildHonoRoute(app, resetTutorialProgressContract, async (c) => {
    const user = requireSignedIn(c)
    return c.json(await requireProgress(c).service.reset(user.id), 200)
  })

  buildHonoRoute(app, recordTutorialEventContract, (c) => {
    // Sign-in is required but the progress store is NOT: counting the funnel has to work on a
    // facade that persists no progress, or a deployment measures nothing for the sake of a
    // feature it did not wire. `assertUser`, not a discarded `requireUser`, because nothing here
    // reads the user and nothing may: the counters carry no per-user dimension, and a line that
    // looks like it fetched one invites the next edit to add it.
    //
    // Sign-in is also the ONLY bound on how often this may be called, which is a deliberate accept
    // rather than an oversight: a signed-in user can inflate the aggregate counts. What that cannot
    // do is cost the operator's metrics backend anything structural, because the `tour` dimension
    // is separately capped (`TutorialTelemetryService`) and nothing here is stored or per-user. A
    // throttle would be worth adding the moment these counters gate a decision rather than inform
    // one; see ADR 0033.
    assertUser(c, SIGN_IN)
    const { event, tourId } = c.req.valid('json')
    c.get('container').tutorialTelemetry.record(event, tourId)
    return c.body(null, 204)
  })

  return app
}
