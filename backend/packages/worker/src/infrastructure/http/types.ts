import type { Container } from '../container'
import type { Env } from '../env'
import type { SessionPayload } from '../auth/signing'

/** Hono generics shared by the app and every controller. */
export type AppEnv = {
  Bindings: Env
  Variables: {
    container: Container
    /** The authenticated user, set by `requireAuth` when auth is enabled. */
    user?: SessionPayload
  }
}
