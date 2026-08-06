// A SECOND HTTP surface for the e2e process: the same app, the same data, the same engine, with
// AUTHENTICATION ON.
//
// The primary backend runs `TESTING_NO_AUTH`, which is what lets 40-odd specs seed and drive over
// anonymous REST. That flag is also why it cannot host the specs whose subject IS identity: the SPA
// renders the board anonymously instead of the login screen (`needsLogin` short-circuits on it) and,
// having no signed-in user, it never resolves one, so a gate policy that names PEOPLE refuses
// everybody in the browser, honestly and uselessly.
//
// The two facts that make a second surface the right answer rather than a second deployment:
//
//   - `authConfig(c)` reads `container.config.auth` PER REQUEST, so an app built over a container
//     whose auth config differs is a full auth-enabled deployment with no forked wiring; and
//   - it is the SAME container, so one Postgres, one pg-boss worker, one set of sweepers and one
//     engine. A run started over the anonymous surface is driven by the same worker and pushed to
//     the browsers watching over this one, which is what lets an auth spec keep using the ordinary
//     REST helpers to set up its state.
//
// Only the WebSocket needs help: the hub the primary listener registers sockets on is created
// inside `start()` and never handed to the container, so this module brings its own and
// {@link fanOutRealtime} tees engine events into both. Without that the auth-side SPA connects and
// then never hears anything.
import {
  createApp,
  type LocalEventSink,
  NodeRealtimeHub,
  serveAppWithRealtime,
  type buildNodeContainer,
} from '@cat-factory/node-server'
import { type Logger } from '@cat-factory/server'

type Container = ReturnType<typeof buildNodeContainer>

/**
 * Tee every engine event into both sinks.
 *
 * `broadcast` is a best-effort fan-out on both facades, so one sink throwing must not cost the
 * other its delivery: a dropped event is a board frozen at a stale status, and the two listeners
 * are independent transports rather than two steps of one.
 *
 * The `logger` is REQUIRED rather than defaulted, because the swallow is the whole risk here: a
 * dropped delivery shows up in the browser as a board that painted once and then never moved, so
 * this one `warn` is the only thing that names the cause. It is the kernel `Logger` port (the
 * process logger the container itself logs through), not a `console` call beside it.
 */
export function fanOutRealtime(
  primary: LocalEventSink,
  secondary: LocalEventSink,
  logger: Logger,
): LocalEventSink {
  return {
    broadcast(workspaceId, payload, originConnectionId) {
      for (const sink of [primary, secondary]) {
        try {
          sink.broadcast(workspaceId, payload, originConnectionId)
        } catch (error) {
          logger.warn('e2e realtime fan-out sink failed', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}

/**
 * The auth-enabled view of a container: identical services, `config.auth` flipped ON.
 *
 * `passwordEnabled` is the provider the sign-in spec drives (email + password, the one login the
 * suite can complete with no external identity provider), and `testingNoAuth` goes OFF because it
 * is precisely the "render the board anonymously" opt-in these specs exist to stop honouring.
 * `openSignup` stays as configured: the spec signs IN as a seeded user, and leaving hosted signup
 * invite-gated keeps this surface a faithful deployment rather than a convenience.
 *
 * `devOpen` goes off with it, and that is not redundancy. Nothing admits an anonymous caller here
 * only because `requireAuth` and `authorizeWsUpgrade` both happen to test `enabled` BEFORE the
 * `devOpen` short-circuit; reverse either branch order, or add a third reader that checks the
 * short-circuit first, and this "auth-enabled" surface serves every route to an anonymous caller
 * while the sign-in spec (which asserts what the SPA RENDERS, not what the API refuses) stays green.
 * A flag whose value is load-bearing only through statement order is not a configuration.
 */
export function authEnabledContainer(container: Container): Container {
  return {
    ...container,
    config: {
      ...container.config,
      auth: {
        ...container.config.auth,
        enabled: true,
        passwordEnabled: true,
        testingNoAuth: false,
        devOpen: false,
      },
    },
  }
}

/**
 * Serve the auth-enabled surface on its own port, with its own WebSocket listener.
 *
 * Returns the hub it registers sockets on, which the caller must tee engine events into (see
 * {@link fanOutRealtime}). The wiring is split that way because the sink has to be composed while
 * the CONTAINER is being built, and this can only run once it exists.
 */
export function serveAuthBackend(opts: {
  container: Container
  hub: NodeRealtimeHub
  env: NodeJS.ProcessEnv
  port: number
  /** The SPA origin allowed to make cross-origin REST calls to this surface. */
  corsOrigin: string
}): void {
  const container = authEnabledContainer(opts.container)
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    PORT: String(opts.port),
    CORS_ALLOWED_ORIGINS: opts.corsOrigin,
  }
  serveAppWithRealtime({
    app: createApp(container, env),
    realtimeHub: opts.hub,
    auth: container.config.auth,
    env,
    label: 'e2e auth-enabled backend',
  })
}
