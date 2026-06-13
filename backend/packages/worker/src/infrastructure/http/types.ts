import type { Container } from '../container'
import type { Env } from '../env'

/** Hono generics shared by the app and every controller. */
export type AppEnv = {
  Bindings: Env
  Variables: { container: Container }
}
