import type { Context } from 'hono'
import type { AppEnv } from './env.js'

/**
 * Where this deployment serves its web app, with no trailing slash: the configured `APP_BASE_URL`
 * when it has one, and the REQUEST's own origin otherwise. The fallback is right for every
 * same-origin install, and a deployment serving the app elsewhere has already had to set
 * `APP_BASE_URL` for its invite and password-reset links to arrive anywhere.
 *
 * A path is APPENDED to this rather than resolved against it: `new URL('/x', base)` keeps only the
 * base's origin, so an app served under a prefix would send every link one segment too high.
 */
export function appBaseUrlFor<E extends AppEnv>(c: Context<E>): string {
  const configured = c.get('container').appBaseUrl?.trim()
  return (configured || new URL(c.req.url).origin).replace(/\/+$/, '')
}
